import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_COMBINE_OPERATION_FAILED',
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
    }) => void) | null = null;

    public readonly postMessageCalls: Array<{
        message: unknown;
        transfer: Transferable[];
    }> = [];

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
        if (type !== 'message' || typeof handler !== 'function') {
            if (type === 'error' && typeof handler === 'function') {
                this.errorHandlers.add(handler as (event: ErrorEvent) => void);
            }
            return;
        }
        this.messageHandlers.add(handler as (event: MessageEvent) => void);
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            if (type === 'error' && typeof handler === 'function') {
                this.errorHandlers.delete(handler as (event: ErrorEvent) => void);
            }
            return;
        }
        this.messageHandlers.delete(handler as (event: MessageEvent) => void);
    }

    public postMessage(message: unknown, transfer: Transferable[]) {
        this.postMessageCalls.push({
            message,
            transfer,
        });

        const request = message as {
            id: number;
            type: string;
        };

        if (FakeWorker.responder) {
            FakeWorker.responder(this, request);
            return;
        }

        queueMicrotask(() => {
            const data = new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
                0x2d,
                0x31,
                0x2e,
                0x37,
            ]);
            const event = {data: {
                id: request.id,
                type: request.type,
                ok: true,
                data: { data },
            }} as MessageEvent;
            this.messageHandlers.forEach((handler) => handler(event));
        });
    }

    public dispatchMessage(data: unknown) {
        const event = {data} as MessageEvent;
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

describe('browserPdfCombineWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        FakeWorker.responder = null;
        failureReporter.capture.mockClear();
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('shares malformed verdicts and keeps writer admission at each named limit', async () => {
        const {parseBrowserPdfCombineWorkerRequest} = await import(
            '@app/platform/browser-api/browserPdfCombineWorker.types'
        );
        const bookmark = (items: unknown[] = []) => ({
            title: 'Chapter α',
            pageIndex: null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items,
        });
        const catalogRequest = (catalog: unknown) => ({
            id: 1,
            type: 'combinePdfs',
            payload: {
                inputs: [{
                    fileName: 'source.pdf',
                    data: new Uint8Array([1]),
                }],
                wasmImagePreprocessing: {catalog},
            },
        });
        const chain = (count: number) => {
            let value = bookmark();
            for (let index = 1; index < count; index += 1) {
                value = bookmark([value]);
            }
            return value;
        };
        const labels = (count: number) => Array.from({length: count}, (_, pageIndex) => ({pageIndex}));
        const missingPageIndex = Object.fromEntries(
            Object.entries(bookmark()).filter(([key]) => key !== 'pageIndex'),
        );
        const malformedCatalogs = [
            {
                bookmarks: [missingPageIndex],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...bookmark(),
                    pageYRatio: 'bad',
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...bookmark(),
                    pageYRatio: Number.NaN,
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...bookmark(),
                    pageYRatio: Number.POSITIVE_INFINITY,
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...bookmark(),
                    items: [{
                        ...bookmark(),
                        pageIndex: undefined,
                    }],
                }],
                pageLabels: [],
            },
        ];

        for (const malformed of malformedCatalogs) {
            expect(parseBrowserPdfCombineWorkerRequest(catalogRequest(malformed))).toBeNull();
        }

        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: [{
                ...bookmark(),
                pageIndex: undefined,
            }],
            pageLabels: [],
        }))).toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: [{
                ...bookmark(),
                pageYRatio: 'bad',
            }],
            pageLabels: [],
        }))).toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: Array.from({length: 5_000}, () => bookmark()),
            pageLabels: labels(2_048),
        }))).not.toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: Array.from({length: 5_001}, () => bookmark()),
            pageLabels: [],
        }))).toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: [chain(64)],
            pageLabels: [],
        }))).not.toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: [chain(65)],
            pageLabels: [],
        }))).toBeNull();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: [],
            pageLabels: labels(2_049),
        }))).toBeNull();
        const sourceBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const sourceSnapshot = sourceBytes.slice();
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest({
            bookmarks: Array.from({length: 5_001}, () => bookmark()),
            pageLabels: [],
        }))).toBeNull();
        expect(sourceBytes).toEqual(sourceSnapshot);

        const unicodeCatalog = {
            bookmarks: [{
                ...bookmark(),
                title: '章节 α',
                pageYRatio: undefined,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: '頁',
            }],
        };
        expect(parseBrowserPdfCombineWorkerRequest(catalogRequest(unicodeCatalog))).toMatchObject({payload: {wasmImagePreprocessing: {catalog: {
            bookmarks: [{
                title: '章节 α',
                pageIndex: null,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: '頁',
            }],
        }}}});
    });

    it('posts cloned PDF buffers to the worker and returns the combined result', async () => {
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');

        const firstSource = new Uint8Array([
            0,
            1,
            2,
            3,
            4,
        ]);
        const secondSource = new Uint8Array([
            0,
            4,
            5,
            6,
            7,
        ]);
        const first = firstSource.subarray(1, 4);
        const second = secondSource.subarray(1, 4);
        const result = await runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [
            cloneCombineWorkerInput('first.pdf', first),
            cloneCombineWorkerInput('second.pdf', second),
        ]});

        expect(result.data).toEqual(new Uint8Array([
            0x25,
            0x50,
            0x44,
            0x46,
            0x2d,
            0x31,
            0x2e,
            0x37,
        ]));
        const worker = FakeWorker.lastInstance;
        expect(worker?.postMessageCalls).toHaveLength(1);
        const firstCall = worker?.postMessageCalls[0];
        expect(firstCall?.transfer).toHaveLength(2);
        const request = firstCall?.message as {payload: {inputs: Array<{ data: Uint8Array }>;};};
        expect(request.payload.inputs[0]?.data.buffer).not.toBe(first.buffer);
        expect(request.payload.inputs[1]?.data.buffer).not.toBe(second.buffer);
    });

    it('rejects a matching-id success response with invalid combined data', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    type: request.type,
                    ok: true,
                    data: { data: 'not-bytes' },
                });
            });
        };
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');

        await expect(runBrowserPdfCombineWorkerRequest(
            'combinePdfs',
            {inputs: [cloneCombineWorkerInput('first.pdf', new Uint8Array([1]))]},
        )).rejects.toThrow('Browser worker returned an invalid result');
    });

    it('reconstructs typed native errors from worker failure responses', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    ok: false,
                    error: 'Image combine WASM request exceeds the admission ceiling',
                    errorEnvelope: {
                        code: 'too-large',
                        message: 'Image combine WASM request exceeds the admission ceiling',
                    },
                });
            });
        };
        const {runBrowserPdfCombineWorkerRequest} = await import(
            '@app/platform/browser-api/browserPdfCombineWorkerClient'
        );

        await expect(runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [{
            fileName: 'first.png',
            data: new Uint8Array([1]),
        }]})).rejects.toMatchObject({
            code: 'too-large',
            errorEnvelope: {
                code: 'too-large',
                message: 'Image combine WASM request exceeds the admission ceiling',
            },
        });
    });

    it('rejects malformed worker error envelopes as invalid responses', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    ok: false,
                    error: 'malformed failure',
                    errorEnvelope: {
                        code: '',
                        message: false,
                    },
                });
            });
        };
        const {runBrowserPdfCombineWorkerRequest} = await import(
            '@app/platform/browser-api/browserPdfCombineWorkerClient'
        );

        await expect(runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [{
            fileName: 'first.png',
            data: new Uint8Array([1]),
        }]})).rejects.toThrow('Browser worker returned an invalid response');
    });

    it('rejects unknown native worker error codes as invalid responses', async () => {
        FakeWorker.responder = (worker, request) => {
            queueMicrotask(() => {
                worker.dispatchMessage({
                    id: request.id,
                    ok: false,
                    error: 'unknown native failure',
                    errorEnvelope: {
                        code: 'future-native-code',
                        message: 'unknown native failure',
                    },
                });
            });
        };
        const {runBrowserPdfCombineWorkerRequest} = await import(
            '@app/platform/browser-api/browserPdfCombineWorkerClient'
        );

        await expect(runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [{
            fileName: 'first.png',
            data: new Uint8Array([1]),
        }]})).rejects.toThrow('Browser worker returned an invalid response');
    });

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');

        await runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [cloneCombineWorkerInput('first.pdf', new Uint8Array([1]))]});
        vi.runAllTicks();
        expect(terminateSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        FakeWorker.responder = () => undefined;
        const {
            cloneCombineWorkerInput,
            runBrowserPdfCombineWorkerRequest,
        } = await import(
            '@app/platform/browser-api/browserPdfCombineWorkerClient'
        );
        const request = runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [cloneCombineWorkerInput('first.pdf', new Uint8Array([1]))]});
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser PDF combine worker');
        }

        worker.dispatchError(new Error('combine worker crashed'));
        const error = await request.then(
            () => { throw new Error('Expected a worker failure'); },
            value => {
                if (!(value instanceof Error)) {
                    throw new Error('Expected a worker failure');
                }
                return value as Error & {failure?: unknown};
            },
        );

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledWith(
            expect.objectContaining({local: expect.objectContaining({source: 'browser-pdf-combine-worker-parent'})}),
            {runtime: 'browser-worker-parent'},
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('terminates active work when the request is aborted', async () => {
        FakeWorker.responder = () => undefined;
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const {runBrowserPdfCombineWorkerRequest} = await import('@app/platform/browser-api/browserPdfCombineWorkerClient');
        const controller = new AbortController();
        const pending = runBrowserPdfCombineWorkerRequest('combinePdfs', {inputs: [{
            fileName: 'first.pdf',
            data: new Uint8Array([1]),
        }]}, controller.signal);

        controller.abort(new DOMException('Canceled', 'AbortError'));

        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(terminateSpy).toHaveBeenCalled();
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });
});
