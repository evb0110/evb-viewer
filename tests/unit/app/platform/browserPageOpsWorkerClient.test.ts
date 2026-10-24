import {getBrowserPageOpsWorkerRequestId} from '@contracts/browserPageOpsWorker';
import {normalizePdfNativeTextBoxAppearanceRequest} from '@contracts/nativePdfMutations';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import {runBrowserPageOpsWorkerRequest} from '@app/platform/browser-api/browserPageOpsWorkerClient';
import {WASM_REQUEST_ALLOCATION_ABI_VERSION} from '@contracts/getCheckedWasmMemoryView';
import {cast} from '@tests/helpers/cast';
import {useWorkspacePrint} from '@app/modules/workspace-shell/composables/useWorkspacePrint';

const failureReceipt = vi.hoisted(() => ({
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_PAGE_OPERATION_FAILED',
    occurredAt: 1,
    severity: 'error',
}));
const failureReporter = vi.hoisted(() => ({capture: vi.fn(() => failureReceipt)}));

function appearanceRequest() {
    return normalizePdfNativeTextBoxAppearanceRequest({
        page: {
            view: [
                0,
                0,
                200,
                100,
            ],
            rotation: 0,
            userUnit: 1,
        },
        textBoxes: [{textBox: {
            stableKey: 'worker-text-box',
            pageIndex: 0,
            text: 'Text',
            rect: [
                10,
                40,
                130,
                70,
            ],
            rotation: 0,
            fontSize: 12,
            color: [
                0,
                0,
                0,
            ],
        }}],
    });
}

vi.mock('@app/utils/failureReporter', () => ({captureRendererFailure: failureReporter.capture}));
// A test can hold the browser yield that page operations take before they start.
const browserYield = vi.hoisted(() => ({held: null as Promise<unknown> | null}));
vi.mock('@app/platform/browser-api/browserYield', () => ({yieldToBrowser: async () => {
    await browserYield.held;
}}));

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;
    public static instances: FakeWorker[] = [];
    public static autoRespond = true;
    public static onPostMessage: ((worker: FakeWorker) => void) | null = null;

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
            message: structuredClone(message, {transfer}),
            transfer,
        });
        FakeWorker.onPostMessage?.(this);
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

function workerRequestId(worker: FakeWorker) {
    const id = getBrowserPageOpsWorkerRequestId(worker.postMessageCalls.at(-1)?.message);
    if (id === null) throw new Error('Worker request has no protocol id');
    return id;
}

function createParseResponse(worker: FakeWorker, data: Uint8Array) {
    const id = workerRequestId(worker);
    return {
        id,
        type: 'parseAnnotations',
        ok: true,
        data: {data},
    };
}

describe('browserPageOpsWorkerClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.unstubAllGlobals();
        FakeWorker.lastInstance = null;
        FakeWorker.instances = [];
        FakeWorker.autoRespond = true;
        FakeWorker.onPostMessage = null;
        failureReporter.capture.mockClear();
        browserYield.held = null;
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    afterEach(async () => {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
        vi.unstubAllGlobals();
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
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('returns saved annotation bytes while cold worker startup is unavailable', async () => {
        const input = Uint8Array.of(1);
        const opened = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: input}, {dedicated: true});
        await vi.advanceTimersByTimeAsync(0);
        await expect(opened).resolves.toEqual({data: Uint8Array.of(2)});
        vi.stubGlobal('Worker', function () { throw new Error('Cold worker startup is unavailable'); });
        const saved = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: input}, {dedicated: true});
        await vi.advanceTimersByTimeAsync(0);
        await expect(saved).resolves.toEqual({data: Uint8Array.of(2)});
        expect(input).toEqual(Uint8Array.of(1));
    });

    it('reports unavailable native appearance generation when a worker cannot start', async () => {
        vi.stubGlobal('Worker', function () { throw new Error('Worker startup is unavailable'); });
        const result = runBrowserPageOpsWorkerRequest('textBoxAppearance', appearanceRequest());
        await expect(result).rejects.toThrow('Text appearance generation requires a worker');
    });

    it('does not report an idle worker termination', async () => {
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
    });

    it('cancels one dedicated parse without resetting an overlapping sibling', async () => {
        FakeWorker.autoRespond = false;
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
        await vi.advanceTimersByTimeAsync(0);

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
        siblingWorker.dispatchMessage(createParseResponse(siblingWorker, siblingResult));
        await expect(sibling).resolves.toEqual({data: siblingResult});

        expect(canceledWorker.terminated).toBe(true);
        expect(siblingWorker.terminated).toBe(false);
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

    it('starts no worker for an operation a page reset rejected while it yielded', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        const yielded = Promise.withResolvers<undefined>();
        browserYield.held = yielded.promise;
        const outcome = runBrowserPageOpsWorkerRequest('decrypt', {
            data: Uint8Array.of(1),
            password: '',
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);

        target.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false}));
        expect(await outcome).toMatchObject({
            name: 'AbortError',
            code: 'BROWSER_WORKER_RESET',
        });
        browserYield.held = null;
        yielded.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeWorker.instances).toEqual([]);
    });

    it('enters no direct engine for an operation a page reset rejected while its module loaded', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        vi.stubGlobal('Worker', undefined);
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        const response = Promise.withResolvers<Response>();
        vi.stubGlobal('fetch', vi.fn(() => response.promise));
        const engineRuns = vi.fn(() => 1);
        const instantiate = vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue(cast({instance: {exports: {
            memory: new WebAssembly.Memory({initial: 2}),
            evb_wasm_request_allocation_abi_version: () => WASM_REQUEST_ALLOCATION_ABI_VERSION,
            evb_pdf_page_ops_alloc: () => 8,
            evb_pdf_page_ops_free: () => undefined,
            evb_pdf_page_ops_run: engineRuns,
            evb_pdf_page_ops_output_ptr: () => 0,
            evb_pdf_page_ops_output_len: () => 0,
            evb_pdf_page_ops_error_ptr: () => 0,
            evb_pdf_page_ops_error_len: () => 0,
        }}}));
        onTestFinished(() => instantiate.mockRestore());
        // A fresh module has not loaded the engine yet.
        vi.resetModules();
        const {runBrowserPageOpsWorkerRequest: runColdRequest} = await import('@app/platform/browser-api/browserPageOpsWorkerClient');
        const outcome = runColdRequest('decrypt', {
            data: Uint8Array.of(1),
            password: '',
        }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);

        target.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false}));
        expect(await outcome).toMatchObject({
            name: 'AbortError',
            code: 'BROWSER_WORKER_RESET',
        });
        response.resolve(new Response(Uint8Array.of(1), {headers: {'content-type': 'application/octet-stream'}}));
        await vi.advanceTimersByTimeAsync(0);

        expect(engineRuns).not.toHaveBeenCalled();
    });

    it('rejects admitted and waiting parses on a page reset and admits a later parse', async () => {
        const target = new EventTarget();
        vi.stubGlobal('window', target);
        FakeWorker.autoRespond = false;
        const outcomes = [
            1,
            2,
            3,
        ].map(byte => runBrowserPageOpsWorkerRequest('parseAnnotations', {data: Uint8Array.of(byte)}, {dedicated: true})
            .catch((error: unknown) => error));
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeWorker.instances).toHaveLength(2);

        target.dispatchEvent(Object.assign(new Event('pagehide'), {persisted: false}));
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeWorker.instances).toHaveLength(2);
        for (const outcome of outcomes) {
            expect(await outcome).toMatchObject({
                name: 'AbortError',
                code: 'BROWSER_WORKER_RESET',
            });
        }
        FakeWorker.autoRespond = true;
        await expect(runBrowserPageOpsWorkerRequest('parseAnnotations', {data: Uint8Array.of(4)}, {dedicated: true}))
            .resolves.toEqual({data: Uint8Array.of(2)});
    });

    it('ignores a late result from a canceled dedicated parse generation', async () => {
        FakeWorker.autoRespond = false;
        const staleController = new AbortController();
        const stale = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([1])}, {
            dedicated: true,
            signal: staleController.signal,
        });
        await vi.advanceTimersByTimeAsync(0);
        const staleWorker = FakeWorker.instances[0];
        if (!staleWorker) {
            throw new Error('Expected a stale annotation parse worker');
        }

        const cancelReason = new Error('stale parse canceled');
        const staleRejection = expect(stale).rejects.toBe(cancelReason);
        staleController.abort(cancelReason);
        await staleRejection;

        const replacement = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([2])}, {dedicated: true});
        await vi.advanceTimersByTimeAsync(0);
        const replacementWorker = FakeWorker.instances[1];
        if (!replacementWorker) {
            throw new Error('Expected a replacement annotation parse worker');
        }

        let replacementOutcome: unknown;
        replacement.then(
            value => { replacementOutcome = value; },
            error => { replacementOutcome = error; },
        );
        staleWorker.dispatchMessage(createParseResponse(staleWorker, new Uint8Array([99])));
        await vi.advanceTimersByTimeAsync(0);
        expect(replacementOutcome).toBeUndefined();

        const replacementResult = new Uint8Array([
            11,
            12,
            13,
        ]);
        replacementWorker.dispatchMessage(createParseResponse(replacementWorker, replacementResult));
        await expect(replacement).resolves.toEqual({data: replacementResult});
        expect(staleWorker.terminated).toBe(true);
        expect(replacementWorker.terminated).toBe(false);
    });

    it('isolates a dedicated worker failure and preserves input ownership', async () => {
        FakeWorker.autoRespond = false;
        const failedInput = new Uint8Array([
            13,
            14,
            15,
        ]);
        const sibling = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: new Uint8Array([16])}, {dedicated: true});
        const failed = runBrowserPageOpsWorkerRequest('parseAnnotations', {data: failedInput}, {dedicated: true});
        await vi.advanceTimersByTimeAsync(0);

        expect(FakeWorker.instances).toHaveLength(2);
        const siblingWorker = FakeWorker.instances[0];
        const failedWorker = FakeWorker.instances[1];
        if (!siblingWorker || !failedWorker) {
            throw new Error('Expected two dedicated annotation parse workers');
        }

        const postedRequest = failedWorker.postMessageCalls[0]?.message as {payload: {data: Uint8Array};} | undefined;
        const workerInput = postedRequest?.payload.data;
        if (!workerInput) {
            throw new Error('Expected a worker-owned annotation parse input');
        }
        expect(workerInput).not.toBe(failedInput);
        expect(workerInput).toEqual(failedInput);
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
        siblingWorker.dispatchMessage(createParseResponse(siblingWorker, siblingResult));
        await expect(sibling).resolves.toEqual({data: siblingResult});

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failedWorker.terminated).toBe(true);
        expect(siblingWorker.terminated).toBe(false);
    });
    it.each([
        'textBoxAppearance',
        'saveMutations',
        'decrypt',
        'printLayout',
    ] as const)(
        'isolates cancellation of %s from an overlapping page operation', async (type) => {
            FakeWorker.autoRespond = false;
            const controller = new AbortController();
            const input = new Uint8Array([
                1,
                2,
                3,
            ]);
            const payload = type === 'textBoxAppearance' ? appearanceRequest() : type === 'saveMutations'
                ? {
                    data: input,
                    mutations: {updates: [{
                        objectNumber: 1,
                        generationNumber: 0,
                        text: 'Saved',
                    }]},
                    modifiedAt: 'D:20260102000000Z',
                }
                : type === 'decrypt'
                    ? {
                        data: input,
                        password: 'transient',
                    }
                    : {
                        data: input,
                        pageNumbers: [],
                        viewMode: 'facing' as const,
                        orientation: 'landscape' as const,
                    };
            const canceled = runBrowserPageOpsWorkerRequest(type, payload, {signal: controller.signal});
            await vi.advanceTimersByTimeAsync(0);
            const sibling = runBrowserPageOpsWorkerRequest('rotate', {
                data: new Uint8Array([4]),
                pages: [1],
                angle: 90,
            });
            const reason = new Error('Document closed');
            const rejection = expect(canceled).rejects.toBe(reason);
            controller.abort(reason);
            await rejection;
            const siblingWorker = FakeWorker.lastInstance;
            if (!siblingWorker) throw new Error('Missing sibling worker');
            const siblingRequest = siblingWorker.postMessageCalls[0]?.message as {id: number};
            siblingWorker.dispatchMessage({
                id: siblingRequest.id,
                type: 'rotate',
                ok: true,
                data: {
                    data: new Uint8Array([5]),
                    pageCount: 1,
                },
            });
            await expect(sibling).resolves.toEqual({
                data: new Uint8Array([5]),
                pageCount: 1,
            });
            expect(input).toEqual(new Uint8Array([
                1,
                2,
                3,
            ]));
        },
    );

    it('stops the isolated layout worker when the workspace print dialog closes', async () => {
        FakeWorker.autoRespond = false;
        const notices: unknown[] = [];
        vi.stubGlobal('useToast', () => ({
            add: (notice: unknown) => { notices.push(notice); return {id: 'print-notice'}; },
            remove: () => undefined,
        }));
        const workerReady = new Promise<FakeWorker>(resolve => { FakeWorker.onPostMessage = resolve; });
        const scope = effectScope();
        const input = new Uint8Array([
            1,
            2,
            3,
        ]);
        const print = scope.run(() => useWorkspacePrint({
            totalPages: ref(2),
            currentPage: ref(1),
            selectedPages: ref([]),
            sourcePdf: ref(null),
            workingCopyPath: ref(null),
            fileName: ref('cancel-print.pdf'),
            hasPendingUnsavedChanges: ref(false),
            getQuickPrintPageMetrics: async () => null,
            getPrintableSourceData: async () => input,
        }));
        if (!print) throw new Error('Missing print owner');
        print.handlePrintDialogOpenChange(true);
        const preparation = print.handlePrintDialogSubmit({
            viewMode: 'facing',
            orientation: 'landscape',
        });
        try {
            const worker = await workerReady;
            print.handlePrintDialogOpenChange(false);
            expect(worker.terminated).toBe(true);
            await preparation;
            expect(print.isPreparingPrint.value).toBe(false);
            expect(notices).toEqual([]);
            expect(input).toEqual(new Uint8Array([
                1,
                2,
                3,
            ]));
        } finally {
            scope.stop();
            // Release the pre-fix pending worker after the failing assertion.
            const worker = FakeWorker.lastInstance;
            const request = worker?.postMessageCalls[0]?.message;
            if (request && typeof request === 'object' && 'id' in request) {
                worker?.dispatchMessage({
                    id: request.id,
                    type: 'printLayout',
                    ok: true,
                    data: {
                        data: new Uint8Array([4]),
                        pageCount: 1,
                    },
                });
            }
            await preparation;
            FakeWorker.autoRespond = true;
            vi.unstubAllGlobals();
        }
    });

    it('preserves typed decrypt and WASM load failures across the worker boundary', async () => {
        FakeWorker.autoRespond = false;
        for (const result of [
            {
                status: 'failed',
                error: {
                    code: 'timeout',
                    message: 'The browser page tool could not be loaded: The WASM module download stalled: no data arrived for 30000ms',
                },
            },
            {
                status: 'failed',
                error: {
                    code: 'needs-password',
                    message: 'Password required',
                },
            },
        ]) {
            const request = runBrowserPageOpsWorkerRequest('decrypt', {
                data: new Uint8Array([1]),
                password: '',
            });
            await vi.advanceTimersByTimeAsync(0);
            FakeWorker.lastInstance?.dispatchMessage({
                id: workerRequestId(FakeWorker.lastInstance!),
                type: 'decrypt',
                ok: true,
                data: result,
            });
            await expect(request).resolves.toEqual(result);
        }
    });

});
