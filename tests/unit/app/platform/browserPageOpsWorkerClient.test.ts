import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
    occurredAt: 1,
    severity: 'error',
};
let reporterAvailable = true;
const failureReporter = {capture: vi.fn(() => failureReceipt)};
const fallbackReporter = vi.fn(() => failureReporter);

vi.mock('@app/utils/failureReporter', () => ({
    detectRendererDiagnosticsHost: () => 'hosted-browser',
    getRendererFailureReporter: () => reporterAvailable ? failureReporter : null,
    initializeRendererFailureReporter: fallbackReporter,
}));

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;
    public static instances: FakeWorker[] = [];
    public static autoRespond = true;

    public readonly postMessageCalls: Array<{
        message: unknown;
        transfer: Transferable[];
    }> = [];
    public terminated = false;

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();
    private readonly errorHandlers = new Set<(event: ErrorEvent) => void>();

    public constructor() {
        FakeWorker.lastInstance = this;
        FakeWorker.instances.push(this);
    }

    public addEventListener(type: string, handler: EventListenerOrEventListenerObject | null) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.add(handler as (event: MessageEvent) => void);
        } else if (type === 'error') {
            this.errorHandlers.add(handler as (event: ErrorEvent) => void);
        }
    }

    public removeEventListener(type: string, handler: EventListenerOrEventListenerObject | null) {
        if (typeof handler !== 'function') {
            return;
        }
        if (type === 'message') {
            this.messageHandlers.delete(handler as (event: MessageEvent) => void);
        } else if (type === 'error') {
            this.errorHandlers.delete(handler as (event: ErrorEvent) => void);
        }
    }

    public postMessage(message: unknown, transfer: Transferable[] = []) {
        this.postMessageCalls.push({
            message,
            transfer,
        });
        if (!FakeWorker.autoRespond) {
            return;
        }
        const request = message as {
            id: number;
            type: string
        };
        queueMicrotask(() => this.dispatchMessage({
            id: request.id,
            type: request.type,
            ok: true,
            data: {
                data: new Uint8Array([2]),
                pageCount: 1,
            },
        }));
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

    public terminate() {
        this.terminated = true;
    }
}

function createParseResponse(id: number, data: Uint8Array) {
    return {
        id,
        type: 'parseAnnotations',
        ok: true,
        data: {data},
    };
}

describe('browserPageOpsWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        FakeWorker.lastInstance = null;
        FakeWorker.instances = [];
        FakeWorker.autoRespond = true;
        failureReporter.capture.mockClear();
        fallbackReporter.mockClear();
        reporterAvailable = true;
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('rejects malformed catalog bookmark fields through the shared codec', async () => {
        const {decodeBrowserPdfCatalog} = await import('@contracts/browserPdfCatalog');
        const baseBookmark = {
            title: 'Chapter',
            pageIndex: null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        };
        const missingPageIndex = Object.fromEntries(
            Object.entries(baseBookmark).filter(([key]) => key !== 'pageIndex'),
        );
        const malformedCatalogs = [
            {
                bookmarks: [missingPageIndex],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...baseBookmark,
                    pageYRatio: 'bad',
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...baseBookmark,
                    pageYRatio: Number.NaN,
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...baseBookmark,
                    pageYRatio: Number.POSITIVE_INFINITY,
                }],
                pageLabels: [],
            },
            {
                bookmarks: [{
                    ...baseBookmark,
                    items: [{
                        ...baseBookmark,
                        pageIndex: undefined,
                    }],
                }],
                pageLabels: [],
            },
        ];
        for (const malformed of malformedCatalogs) {
            expect(decodeBrowserPdfCatalog(malformed, {maxPageLabels: 2_048})).toBeNull();
        }
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                pageIndex: undefined,
            }],
            pageLabels: [],
        }, {maxPageLabels: 2_048})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                pageYRatio: 'bad',
            }],
            pageLabels: [],
        }, {maxPageLabels: 2_048})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                pageYRatio: 0.25,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: 'Page ',
            }],
        }, {maxPageLabels: 2_048})).toEqual({
            bookmarks: [{
                ...baseBookmark,
                pageYRatio: 0.25,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: 'Page ',
            }],
        });
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                title: '章节 α',
                pageYRatio: undefined,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: '頁',
            }],
        }, {maxPageLabels: 2_048})).toMatchObject({
            bookmarks: [{
                title: '章节 α',
                pageIndex: null,
            }],
            pageLabels: [{
                pageIndex: 0,
                prefix: '頁',
            }],
        });
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                pageYRatio: Number.NaN,
            }],
            pageLabels: [],
        }, {maxPageLabels: 2_048})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                pageYRatio: Number.POSITIVE_INFINITY,
            }],
            pageLabels: [],
        }, {maxPageLabels: 2_048})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [{
                ...baseBookmark,
                items: [{
                    ...baseBookmark,
                    pageIndex: undefined,
                }],
            }],
            pageLabels: [],
        }, {maxPageLabels: 2_048})).toBeNull();
    });

    it('enforces the named reader budgets at the exact boundary and one over', async () => {
        const {
            decodeBrowserPdfCatalog, BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH,
            BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS, BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS,
            BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS,
        } = await import('@contracts/browserPdfCatalog');
        const bookmark = (items: unknown[] = []) => ({
            title: 'Chapter α',
            pageIndex: null,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items,
        });
        const labels = (count: number) => Array.from({length: count}, (_, pageIndex) => ({pageIndex}));
        const chain = (count: number) => {
            let value = bookmark();
            for (let index = 1; index < count; index += 1) {
                value = bookmark([value]);
            }
            return value;
        };

        expect(decodeBrowserPdfCatalog({
            bookmarks: Array.from({length: BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS}, () => bookmark()),
            pageLabels: labels(BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS),
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS})).not.toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: Array.from({length: BROWSER_PDF_CATALOG_MAX_BOOKMARK_ITEMS + 1}, () => bookmark()),
            pageLabels: [],
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [chain(BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH)],
            pageLabels: [],
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS})).not.toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [chain(BROWSER_PDF_CATALOG_MAX_BOOKMARK_DEPTH + 1)],
            pageLabels: [],
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS})).toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [],
            pageLabels: labels(BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS),
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS})).not.toBeNull();
        expect(decodeBrowserPdfCatalog({
            bookmarks: [],
            pageLabels: labels(BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS + 1),
        }, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WASM_PAGE_LABELS})).toBeNull();
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const request = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser page operations worker');
        }

        worker.dispatchError(new Error('page operations worker crashed'));
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
            expect.objectContaining({local: expect.objectContaining({source: 'browser-page-ops-worker-parent'})}),
            {runtime: 'browser-worker-parent'},
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('does not report an idle worker termination', async () => {
        vi.useFakeTimers();
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const result = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        await result;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledOnce();
        expect(failureReporter.capture).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('uses a fallback reporter when the shared reporter is unavailable', async () => {
        reporterAvailable = false;
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const request = runBrowserPageOpsWorkerRequest('rotate', {
            data: new Uint8Array([1]),
            pages: [1],
            angle: 90,
        });
        const worker = FakeWorker.lastInstance;
        if (!worker) {
            throw new Error('Expected a browser page operations worker');
        }

        worker.dispatchError(new Error('page operations worker crashed'));
        await request.catch(() => undefined);

        expect(fallbackReporter).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledOnce();
    });

    it('cancels one dedicated parse without resetting an overlapping sibling', async () => {
        FakeWorker.autoRespond = false;
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const canceledController = new AbortController();
        const canceledInput = new Uint8Array([
            1,
            2,
            3,
        ]);
        const siblingInput = new Uint8Array([
            4,
            5,
            6,
        ]);
        const canceled = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: canceledInput}, {
            dedicated: true,
            signal: canceledController.signal,
        });
        const sibling = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: siblingInput}, {dedicated: true});
        await Promise.resolve();

        expect(FakeWorker.instances).toHaveLength(2);
        const canceledWorker = FakeWorker.instances[0];
        const siblingWorker = FakeWorker.instances[1];
        if (!canceledWorker || !siblingWorker) {
            throw new Error('Expected two dedicated annotation parse workers');
        }

        const cancelReason = new Error('parse replaced');
        canceledController.abort(cancelReason);
        await expect(canceled).rejects.toBe(cancelReason);

        const siblingResult = new Uint8Array([
            7,
            8,
            9,
            10,
        ]);
        siblingWorker.dispatchMessage(createParseResponse(1, siblingResult));
        await expect(sibling).resolves.toEqual({data: siblingResult});

        expect(canceledWorker.terminated).toBe(true);
        expect(siblingWorker.terminated).toBe(true);
        expect(canceledInput).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
        expect(siblingInput).toEqual(new Uint8Array([
            4,
            5,
            6,
        ]));
    });

    it('ignores a late result from a canceled dedicated parse generation', async () => {
        FakeWorker.autoRespond = false;
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const staleController = new AbortController();
        const stale = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([1])}, {
            dedicated: true,
            signal: staleController.signal,
        });
        await Promise.resolve();
        const staleWorker = FakeWorker.instances[0];
        if (!staleWorker) {
            throw new Error('Expected a stale annotation parse worker');
        }

        const cancelReason = new Error('stale parse canceled');
        const staleRejection = expect(stale).rejects.toBe(cancelReason);
        staleController.abort(cancelReason);
        await staleRejection;

        const replacement = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([2])}, {dedicated: true});
        await Promise.resolve();
        const replacementWorker = FakeWorker.instances[1];
        if (!replacementWorker) {
            throw new Error('Expected a replacement annotation parse worker');
        }

        let replacementOutcome: unknown;
        replacement.then(
            value => { replacementOutcome = value; },
            error => { replacementOutcome = error; },
        );
        staleWorker.dispatchMessage(createParseResponse(1, new Uint8Array([99])));
        await Promise.resolve();
        expect(replacementOutcome).toBeUndefined();

        const replacementResult = new Uint8Array([
            11,
            12,
            13,
        ]);
        replacementWorker.dispatchMessage(createParseResponse(1, replacementResult));
        await expect(replacement).resolves.toEqual({data: replacementResult});
        expect(staleWorker.terminated).toBe(true);
        expect(replacementWorker.terminated).toBe(true);
    });

    it('isolates a dedicated worker failure and preserves input ownership before transfer', async () => {
        FakeWorker.autoRespond = false;
        const {runBrowserPageOpsWorkerRequest} = await import(
            '@app/platform/browser-api/browserPageOpsWorkerClient'
        );
        const failedInput = new Uint8Array([
            13,
            14,
            15,
        ]);
        const sibling = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([16])}, {dedicated: true});
        const failed = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: failedInput}, {dedicated: true});
        await Promise.resolve();

        expect(FakeWorker.instances).toHaveLength(2);
        const siblingWorker = FakeWorker.instances[0];
        const failedWorker = FakeWorker.instances[1];
        if (!siblingWorker || !failedWorker) {
            throw new Error('Expected two dedicated annotation parse workers');
        }

        const postedRequest = failedWorker.postMessageCalls[0]?.message as {payload: {data: Uint8Array};} | undefined;
        const transferredInput = postedRequest?.payload.data;
        if (!transferredInput) {
            throw new Error('Expected a transferred annotation parse input');
        }
        expect(transferredInput).not.toBe(failedInput);
        expect(transferredInput).toEqual(failedInput);
        expect(failedWorker.postMessageCalls[0]?.transfer).toContain(transferredInput.buffer);
        expect(failedInput).toEqual(new Uint8Array([
            13,
            14,
            15,
        ]));

        failedWorker.dispatchError(new Error('dedicated parse worker crashed'));
        await expect(failed).rejects.toThrow('dedicated parse worker crashed');

        const siblingResult = new Uint8Array([
            21,
            22,
            23,
            24,
        ]);
        siblingWorker.dispatchMessage(createParseResponse(1, siblingResult));
        await expect(sibling).resolves.toEqual({data: siblingResult});

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failedWorker.terminated).toBe(true);
        expect(siblingWorker.terminated).toBe(true);
    });
});
