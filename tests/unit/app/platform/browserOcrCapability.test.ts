import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import type {
    IScanCleanupDetectionResult,
    IScanCleanupPreviewRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    IBrowserScanCleanupPreviewBase,
    IBrowserScanCleanupPreviewRendering,
    IRenderBrowserScanCleanupPreviewInput,
} from '@app/platform/browser-api/browserScanCleanupJob';
import {cast} from '@tests/helpers/cast';

const browserPlatformWiringTimeoutMs = 8_000;

describe('browser OCR capability', {timeout: 20_000}, () => {
    beforeAll(async () => {
        // The first import transforms the whole browser platform, which takes
        // seconds on a loaded machine. Pay that once here so the wiring budget
        // below measures the wiring, not the transform.
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await import('@app/platform/browserPlatformApi');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('closes every raster tile when allocating the assembled PPM fails', async () => {
        const {assembleBrowserPdfRasterPpm} = await import('@app/platform/browser-api/assembleBrowserPdfRasterPpm');
        const states = [
            {closed: false},
            {closed: false},
        ];
        const tiles = states.map(state => cast<ImageBitmap>({
            width: 1,
            height: 1,
            close() { state.closed = true; },
        }));
        vi.stubGlobal('OffscreenCanvas', class {
            public width = 1;
            public height = 1;
        });
        try {
            expect(() => assembleBrowserPdfRasterPpm({
                width: Number.MAX_SAFE_INTEGER,
                height: 2,
                tiles,
            })).toThrow(RangeError);
            expect(states.map(state => state.closed)).toEqual([
                true,
                true,
            ]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('refuses OCR with its reason when the browser cannot run the engine', async () => {
        vi.stubGlobal('Worker', undefined);
        try {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['eng'],
            }], requireRequestId('request-2'))).resolves.toMatchObject({
                started: false,
                errorEnvelope: {
                    code: 'OCR_BROWSER_UNSUPPORTED',
                    message: 'OCR_BROWSER_UNSUPPORTED',
                },
            });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    describe('in a browser that can run the engine', () => {
        beforeEach(() => {
            vi.stubGlobal('Worker', function Worker() {});
            vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});
        });
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('offers every desktop language, each still to download', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');
            const { AVAILABLE_OCR_LANGUAGES } = await import('@contracts/ocrLanguages');

            const languages = await browserOcrCapability.getLanguages();
            expect(languages.map(language => language.code))
                .toEqual(AVAILABLE_OCR_LANGUAGES.map(language => language.code));
            expect(new Set(languages.map(language => language.modelState))).toEqual(new Set(['missing']));
        });

        it('refuses a language outside the registry', async () => {
            const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.createSearchablePdf(requireDocumentRef('browser://documents/a/in.pdf'), [{
                pageNumber: requirePageNumber(1),
                languages: ['xyz'],
            }], requireRequestId('request-3'))).resolves.toMatchObject({
                started: false,
                error: 'Unsupported OCR language: xyz',
                errorEnvelope: {code: 'OCR_INVALID_PAYLOAD'},
            });
        });
    });

    it('reports unknown jobs and results without touching documents', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel(requireRequestId('request-5'))).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        await expect(browserOcrCapability.acknowledgeResultFile(
            requireRequestId('request-5'),
            requireDocumentRef('browser://documents/b/result.pdf'),
        )).resolves.toEqual({cleaned: false});
    });

    it('wires the browser platform to the browser OCR capability', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { browserPlatformApi } = await import('@app/platform/browserPlatformApi');
        const { browserOcrCapability } = await import('@app/platform/browser-api/browserOcrCapability');

        expect(browserPlatformApi.ocr).toBe(browserOcrCapability);
    }, browserPlatformWiringTimeoutMs);
});

interface IPendingRender {
    input: IRenderBrowserScanCleanupPreviewInput;
    resolve: (rendering: IBrowserScanCleanupPreviewRendering) => void;
}

const renders = {pending: [] as IPendingRender[]};
const destroyed = {count: 0};

/** The source boundary and the job's renders, settled by each test. */
function mockScanCleanupPreviewSource() {
    vi.doMock('@app/platform/browser-api/browserScanCleanupJob', () => ({renderBrowserScanCleanupWorkspacePreview: (input: IRenderBrowserScanCleanupPreviewInput) => new Promise<IBrowserScanCleanupPreviewRendering>((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
        renders.pending.push({
            input,
            resolve,
        });
    })}));
    vi.doMock('@app/platform/browserDocumentStore', () => ({
        getBrowserDocumentFileName: () => 'scan.pdf',
        browserDocumentStore: {
            assertDocumentRevisionCurrent: vi.fn(async () => undefined),
            read: vi.fn(async () => new Uint8Array([
                1,
                2,
                3,
            ])),
            readableBlob: vi.fn(async () => new Blob([new Uint8Array([
                1,
                2,
                3,
            ])])),
            readableRevision: vi.fn(async (_ref: string, expected?: {token?: string}) => ({
                blob: new Blob([new Uint8Array([
                    1,
                    2,
                    3,
                ])]),
                token: expected?.token ?? 'revision-1',
                byteRevision: 1,
                instance: Symbol('scan-preview-source'),
            })),
        },
    }));
    vi.doMock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({
        evictBrowserPageOpsDocumentCache: vi.fn(),
        runBrowserPageOpsWorkerRequest: vi.fn(async () => ({
            pageCount: 2,
            pages: [
                1,
                2,
            ].map(pageNumber => ({
                pageNumber,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                rasterUses: [],
                rasterInventoryComplete: true,
                hasAnnotations: false,
            })),
        })),
    }));
    vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({loadBrowserPdfjsDocument: vi.fn(async () => ({
        numPages: 2,
        loadingTask: {destroy: vi.fn(async () => {
            destroyed.count += 1;
        })},
    }))}));
}

const scanCleanupPreviewOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'ink',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
} satisfies IScanCleanupPreviewRequest['options'];

let nextRequest = 0;
function request(overrides: Partial<IScanCleanupPreviewRequest> = {}): IScanCleanupPreviewRequest {
    nextRequest += 1;
    return {
        requestId: requireRequestId(`preview-${String(nextRequest)}`),
        sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
        ownerId: 'owner-1',
        documentRevision: 'revision-1',
        pageNumber: requirePageNumber(1),
        options: scanCleanupPreviewOptions,
        visible: true,
        ...overrides,
    };
}

function rendering(pageNumber: number, base: IBrowserScanCleanupPreviewBase | null = null): IBrowserScanCleanupPreviewRendering {
    return {
        result: {
            pageNumber: requirePageNumber(pageNumber),
            totalPages: 2,
            rawWidthPx: 100,
            rawHeightPx: 100,
            pageMetadata: {} as never,
            outputs: [],
        },
        base,
    };
}

const retainedBase = cast<IBrowserScanCleanupPreviewBase>({pageSize: {pageNumber: 1}});

async function settleTurns() {
    for (let turn = 0; turn < 10; turn += 1) {await Promise.resolve();}
}

describe('browser scan cleanup preview admission', () => {
    beforeEach(() => {
        vi.resetModules();
        renders.pending = [];
        destroyed.count = 0;
        mockScanCleanupPreviewSource();
    });

    afterEach(() => {
        for (const path of [
            '@app/platform/browser-api/browserScanCleanupJob',
            '@app/platform/browserDocumentStore',
            '@app/platform/browser-api/browserPageOpsWorkerClient',
            '@app/platform/browser-api/loadBrowserPdfjsDocument',
        ]) {vi.doUnmock(path);}
    });

    async function loadCapability() {
        return (await import('@app/platform/browser-api/browserScanCleanupCapability')).browserScanCleanupCapability;
    }

    it.each([
        {job: 'detection', retire: false},
        {job: 'conversion', retire: false},
        {job: 'detection', retire: true},
        {job: 'conversion', retire: true},
    ] as const)('answers a late browser $job subscriber with the terminal state or retirement (retire=$retire)', async ({
        job, retire,
    }) => {
        const capability = await loadCapability();
        const {browserDocumentStore} = await import('@app/platform/browserDocumentStore');
        const failure = 'Fixture source went away';
        vi.mocked(browserDocumentStore.assertDocumentRevisionCurrent).mockRejectedValue(new Error(failure));
        const input = request();
        const detection = job === 'detection';
        const terminal = Promise.withResolvers<TScanCleanupDetectionJobState | TScanCleanupJobState>();
        const events: unknown[] = [];
        const listen = detection ? capability.onDetectionJobState : capability.onJobState;
        const subscribe = detection ? capability.subscribeDetectionJob : capability.subscribeJob;
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
        const stop = listen(state => {
            events.push(state);
            if (state.status === 'failed' || state.status === 'completed' || state.status === 'canceled') {
                terminal.resolve(state);
            }
        });
        try {
            const started = await (detection ? capability.detectAll(input) : capability.start(input));
            expect(started.started).toBe(true);
            const expected = {jobId: started.jobId, status: 'failed', error: failure};
            await expect(terminal.promise).resolves.toMatchObject(expected);
            await expect(subscribe(started.jobId, input)).resolves.toMatchObject(expected);
            const reconnect = detection ? capability.subscribeDetectionJob : capability.reconnectJob;
            await expect(reconnect(started.jobId, input)).resolves.toMatchObject(expected);
            if (retire) {
                // Move only the owner's retention clock. Arrival of the
                // retirement event should require no renderer state read.
                await vi.advanceTimersByTimeAsync(60_000);
                expect(events).toContainEqual(expect.objectContaining({
                    jobId: started.jobId,
                    status: 'retired',
                }));
            }
        } finally {
            stop();
            vi.useRealTimers();
        }
    });

    it('leaves no PDF source open when the working copy closes before a preview is admitted', async () => {
        const capability = await loadCapability();
        const {closeBrowserWorkingCopyWork} = await import('@app/platform/browser-api/browserWorkingCopyClose');
        const loadPdf = vi.mocked((await import('@app/platform/browser-api/loadBrowserPdfjsDocument')).loadBrowserPdfjsDocument);

        const preview = capability.preview(request());
        const close = closeBrowserWorkingCopyWork(requireDocumentRef('/docs/scan.pdf'));
        await expect(preview).resolves.toEqual({canceled: true});
        await close;
        await settleTurns();

        expect(renders.pending).toHaveLength(0);
        expect(destroyed.count).toBe(loadPdf.mock.calls.length);
    });

    it('declines a speculative neighbour without retiring the visible page', async () => {
        const capability = await loadCapability();
        const visible = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));

        await expect(capability.preview(request({
            visible: false,
            pageNumber: requirePageNumber(2),
        }))).resolves.toEqual({canceled: true});

        renders.pending[0]!.resolve(rendering(1));
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        expect(renders.pending).toHaveLength(1);
    });

    it('refines a base that is still rendering once it lands, without canceling the detail', async () => {
        const capability = await loadCapability();
        const base = request();
        const basePreview = capability.preview(base);
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const detail = capability.preview(request({
            visible: false,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 0.5,
                    heightNormalized: 0.5,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        }));
        await settleTurns();
        // The detail waits for its base instead of starting or retiring it.
        expect(renders.pending).toHaveLength(1);

        renders.pending[0]!.resolve(rendering(1, retainedBase));
        await expect(basePreview).resolves.toMatchObject({pageNumber: 1});
        await vi.waitFor(() => expect(renders.pending).toHaveLength(2));
        expect(renders.pending[1]!.input.base).toBe(retainedBase);
        renders.pending[1]!.resolve(rendering(1));
        await expect(detail).resolves.toMatchObject({
            pageNumber: 1,
            requestId: expect.stringContaining('preview-'),
        });
    });

    it('shares one render between two requests for the same picture', async () => {
        const capability = await loadCapability();
        const first = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const second = capability.preview(request());
        await settleTurns();
        expect(renders.pending).toHaveLength(1);
        renders.pending[0]!.resolve(rendering(1));
        const [
            firstResult,
            secondResult,
        ] = await Promise.all([
            first,
            second,
        ]);
        expect(firstResult).toMatchObject({pageNumber: 1});
        expect(secondResult).toMatchObject({pageNumber: 1});
        expect('requestId' in firstResult && 'requestId' in secondResult && firstResult.requestId !== secondResult.requestId).toBe(true);
    });

    it('renders a visible page once when navigation retains and reschedules it', async () => {
        const capability = await loadCapability();
        const visible = request();
        const first = capability.preview(visible);
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));

        const navigation = {
            sourcePdfPath: visible.sourcePdfPath,
            ownerId: visible.ownerId,
            documentRevision: visible.documentRevision,
            retainPages: [visible.pageNumber],
            invalidateRawCache: false,
        };
        const retired = await capability.cancelPreview(navigation);
        const replacement = request();
        const second = capability.preview(replacement);
        try {
            // Queue behind the replacement's admission before releasing the
            // engine. This cancellation is for an unrelated owner.
            await capability.cancelPreview({...navigation, ownerId: 'other-owner'});
            if (retired) {
                await vi.waitFor(() => expect(renders.pending).toHaveLength(2));
            }
            for (const render of renders.pending) {
                render.resolve(rendering(1));
            }
            const results = await Promise.all([
                first,
                second,
            ]);
            expect(renders.pending.map(render => render.input.request.pageNumber)).toEqual([visible.pageNumber]);
            expect(results).toMatchObject([
                {pageNumber: visible.pageNumber, requestId: visible.requestId},
                {pageNumber: visible.pageNumber, requestId: replacement.requestId},
            ]);
        } finally {
            await capability.cancelPreview({
                ...navigation,
                retainPages: [],
                invalidateRawCache: true,
            });
            await Promise.allSettled([
                first,
                second,
            ]);
        }
    });

    it('retires a base for another page and answers it canceled', async () => {
        const capability = await loadCapability();
        const first = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const second = capability.preview(request({pageNumber: requirePageNumber(2)}));
        await expect(first).resolves.toEqual({canceled: true});
        await vi.waitFor(() => expect(renders.pending).toHaveLength(2));
        renders.pending[1]!.resolve(rendering(2));
        await expect(second).resolves.toMatchObject({pageNumber: 2});
    });

    it('refuses a detail with no base of the same picture', async () => {
        const capability = await loadCapability();
        await expect(capability.preview(request({
            visible: false,
            detail: {
                viewports: {full: {
                    xNormalized: 0,
                    yNormalized: 0,
                    widthNormalized: 1,
                    heightNormalized: 1,
                    rotationDegrees: 0,
                }},
                outputMode: 'bw',
            },
        }))).rejects.toThrow('rebuild the base preview');
    });

    it('cancels its own owner\'s work and releases the source when the raw cache is invalidated', async () => {
        const capability = await loadCapability();
        const visible = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        await expect(capability.cancelPreview({
            sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
            ownerId: 'someone-else',
            documentRevision: 'revision-1',
        })).resolves.toBe(false);
        await expect(capability.cancelPreview({
            sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
            ownerId: 'owner-1',
            documentRevision: 'revision-1',
            invalidateRawCache: true,
        })).resolves.toBe(true);
        await expect(visible).resolves.toEqual({canceled: true});
        await vi.waitFor(() => expect(destroyed.count).toBe(1));
    });
});

describe('browser scan cleanup preview plan', () => {
    afterEach(() => {
        for (const path of [
            '@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore',
            '@app/platform/browser-api/browserScanCleanupSources',
            '@app/platform/browser-api/runBrowserScanCleanupDetection',
        ]) {vi.doUnmock(path);}
    });

    it.each([
        2,
        1025,
    ])('retains the selected page evidence for an unmatched preview of %s pages', async pageCount => {
        vi.resetModules();
        const {createMemoryScanCleanupDetectionResultStore} = await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const store = createMemoryScanCleanupDetectionResultStore(pageCount);
        const pageNumber = requirePageNumber(1);
        const record = cast<IScanCleanupDetectionResult>({
            pageNumber,
            classification: 'two-page-spread',
            confidence: 1,
            cutterXPx: 877,
            tier1Verdict: 'two-page-spread',
            reconciled: true,
            clusterAgreement: 1,
            documentPrior: {agreementStrength: 0.8},
            recommendedOutputMode: 'mixed',
            softAlphaForegroundRecommendation: true,
            pagePlanEvidence: {
                pageNumber,
                rotationDegrees: 0,
                layoutClassification: 'two-page-spread',
                outputs: {},
            },
            sourcePageMetadata: {
                pageNumber,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 842,
                heightPoints: 634,
                rotation: 0,
                sourceDpi: 150,
                renderBox: 'mediabox',
            },
        });
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({createIndexedDbScanCleanupDetectionResultStore: async () => store}));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: pageCount})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({runBrowserScanCleanupDetection: async ({resultStore}: {resultStore: typeof store}) => {
            await resultStore.append(record);
            return {
                resultStore,
                results: [record],
                blankPageCount: 0,
            };
        }}));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const {narrowScanCleanupPreviewRequestToPage} = await import('@contracts/scan-cleanup/narrowScanCleanupPreviewRequestToPage');
        const owner = createBrowserScanCleanupDetectionOwner();
        const detection = request({options: {
            ...scanCleanupPreviewOptions,
            matchPageSize: false,
            pageOverrides: {'2': cast({rotationDegrees: 90})},
        }});
        const job = await owner.detectAll(detection);
        await vi.waitFor(async () => expect((await owner.getDetectionJobState(job.jobId, detection))?.status).toBe('completed'));
        const preview = narrowScanCleanupPreviewRequestToPage(detection);
        const planned = await owner.resolvePreviewPagePlan(preview);
        expect(planned).toMatchObject({
            layoutByPage: {'1': 'two-page-spread'},
            pagePlanEvidence: record.pagePlanEvidence,
            sourcePageMetadata: record.sourcePageMetadata,
            documentPrior: record.documentPrior,
            outputModeRecommendation: 'mixed',
            softAlphaForegroundRecommendation: true,
        });
        const explicitOutput = await owner.resolvePreviewPagePlan({
            ...preview,
            options: {
                ...preview.options,
                pageOverrideDefaults: createScanCleanupPageOverride({outputModeOverride: 'bw'}),
            },
        });
        expect(explicitOutput.pagePlanEvidence).toEqual(record.pagePlanEvidence);
        expect(explicitOutput.outputModeRecommendation).toBeUndefined();
        expect(explicitOutput.softAlphaForegroundRecommendation).toBeUndefined();
        const changed = await owner.resolvePreviewPagePlan({
            ...preview,
            options: {
                ...preview.options,
                crop: false,
            },
        });
        expect(changed.pagePlanEvidence).toBeUndefined();
        owner.closeSource(requireDocumentRef(detection.sourcePdfPath));
    });

    it('keeps a live preview page plan and all layouts in one snapshot during reconciliation', async () => {
        vi.resetModules();
        const {createMemoryScanCleanupDetectionResultStore} = await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const store = createMemoryScanCleanupDetectionResultStore(2000, 1);
        const result = (pageNumber: number, classification: IScanCleanupDetectionResult['classification']): IScanCleanupDetectionResult => ({
            pageNumber: requirePageNumber(pageNumber),
            revision: 1,
            classification,
            confidence: 1,
            cutterXPx: null,
            tier1Verdict: classification,
            reconciled: true,
            clusterAgreement: 1,
            documentPrior: null,
            pagePlanEvidence: {
                pageNumber: requirePageNumber(pageNumber),
                rotationDegrees: 0,
                layoutClassification: classification,
                outputs: {},
            },
        });
        await store.append(result(1, 'two-page-spread'));
        await store.append(result(2000, 'two-page-spread'));
        const walk = store.forEachChunk;
        let reconciled = false;
        store.forEachChunk = callback => walk(async (rows, firstPageNumber) => {
            await callback(rows, firstPageNumber);
            if (!reconciled) {
                reconciled = true;
                await store.replace(1, result(1, 'single-uncut-page'));
                await store.replace(2000, result(2000, 'single-uncut-page'));
            }
        });
        const running = Promise.withResolvers<undefined>();
        const entered = Promise.withResolvers<undefined>();
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({createIndexedDbScanCleanupDetectionResultStore: async () => store}));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: 2000})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({runBrowserScanCleanupDetection: async () => {
            entered.resolve(undefined);
            await running.promise;
            return {
                resultStore: store,
                results: [],
                blankPageCount: 0,
            };
        }}));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const owner = createBrowserScanCleanupDetectionOwner();
        const preview = request({layoutByPage: {'2000': 'single-uncut-page'}});
        await owner.detectAll(preview);
        await entered.promise;
        try {
            const snapshot = await owner.resolvePreviewPagePlan(preview);
            expect(snapshot.layoutByPage?.['2000']).toBe(snapshot.layoutByPage?.['1']);
            expect(snapshot.pagePlanEvidence?.layoutClassification).toBe(snapshot.layoutByPage?.['1']);
            await store.replace(1, result(1, 'single-uncut-page'));
            await store.replace(2000, result(2000, 'single-uncut-page'));
            const next = await owner.resolvePreviewPagePlan(preview);
            expect(next.layoutByPage?.['2000']).toBe('single-uncut-page');
            expect(next.pagePlanEvidence?.layoutClassification).toBe('single-uncut-page');
            expect(snapshot.layoutByPage?.['1']).toBe('two-page-spread');
        } finally {
            running.resolve(undefined);
            owner.closeSource(requireDocumentRef(preview.sourcePdfPath));
        }
    });

    it('reads a reconciled layout a running detection replaced since the last preview', async () => {
        vi.resetModules();
        const {createMemoryScanCleanupDetectionResultStore} = await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const result = (classification: 'two-page-spread' | 'single-uncut-page') => cast<IScanCleanupDetectionResult>({
            pageNumber: requirePageNumber(1),
            revision: 2,
            classification,
            confidence: 1,
            cutterXPx: 1275,
            tier1Verdict: classification,
            reconciled: true,
            clusterAgreement: 1,
            documentPrior: null,
        });
        const running = Promise.withResolvers<undefined>();
        let liveStore: ReturnType<typeof createMemoryScanCleanupDetectionResultStore> | null = null;
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({createIndexedDbScanCleanupDetectionResultStore: async (count: number) => createMemoryScanCleanupDetectionResultStore(count)}));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: 2000})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({runBrowserScanCleanupDetection: async ({resultStore}: {resultStore: ReturnType<typeof createMemoryScanCleanupDetectionResultStore>}) => {
            liveStore = resultStore;
            await resultStore.append(result('two-page-spread'));
            await running.promise;
            return {
                resultStore,
                results: [],
                blankPageCount: 0,
            };
        }}));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const owner = createBrowserScanCleanupDetectionOwner();
        const preview = request({options: {
            ...scanCleanupPreviewOptions,
            outputMode: 'bw',
        }});
        await owner.detectAll(preview);
        await vi.waitFor(() => expect(liveStore?.resultCount).toBe(1));
        expect((await owner.resolvePreviewPagePlan(preview)).layoutByPage?.['1']).toBe('two-page-spread');

        await liveStore!.replace(1, result('single-uncut-page'));

        expect((await owner.resolvePreviewPagePlan(preview)).layoutByPage?.['1']).toBe('single-uncut-page');
        running.resolve(undefined);
        owner.closeSource(requireDocumentRef('/docs/scan.pdf'));
    });

    it('matches the canvas to every detected page, not only the ones the renderer still keeps', async () => {
        vi.resetModules();
        const pageCount = 1025;
        const {createMemoryScanCleanupDetectionResultStore} = await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const {
            addScanCleanupDocumentCanvasPage,
            createScanCleanupDocumentCanvasAccumulator,
            resolveScanCleanupProvisionalDocumentCanvasFromAccumulator,
        } = await import('@evb/scan-cleanup/core/policy/documentCanvas');
        const spread = (pageNumber: number) => cast<IScanCleanupDetectionResult>({
            pageNumber: requirePageNumber(pageNumber),
            revision: 2,
            classification: 'two-page-spread',
            confidence: 1,
            cutterXPx: 1275,
            tier1Verdict: 'two-page-spread',
            reconciled: true,
            clusterAgreement: 1,
            documentPrior: null,
        });
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({createIndexedDbScanCleanupDetectionResultStore: async (count: number) => createMemoryScanCleanupDetectionResultStore(count)}));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: pageCount})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({runBrowserScanCleanupDetection: async ({resultStore}: {resultStore: ReturnType<typeof createMemoryScanCleanupDetectionResultStore>}) => {
            for (let page = 1; page <= pageCount; page += 1) {await resultStore.append(spread(page));}
            return {
                resultStore,
                results: [],
                blankPageCount: 0,
            };
        }}));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const owner = createBrowserScanCleanupDetectionOwner();
        const preview = request({options: {
            ...scanCleanupPreviewOptions,
            outputMode: 'bw',
        }});
        const job = await owner.detectAll(preview);
        await vi.waitFor(async () => expect((await owner.getDetectionJobState(job.jobId, preview))?.status).toBe('completed'));
        // The renderer keeps only its last 256 layouts.
        const kept = Object.fromEntries(Array.from({length: 256}, (_, index) => [
            String(pageCount - 255 + index),
            'two-page-spread' as const,
        ]));

        const planned = await owner.resolvePreviewPagePlan({
            ...preview,
            layoutByPage: kept,
            layoutDetectionComplete: true,
        });

        expect(Object.keys(planned.layoutByPage ?? {})).toHaveLength(pageCount);
        const accumulator = createScanCleanupDocumentCanvasAccumulator();
        for (let page = 1; page <= pageCount; page += 1) {addScanCleanupDocumentCanvasPage(accumulator, {
            pageNumber: page,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 1224,
            heightPoints: 792,
            rotation: 0,
        }, planned.options, planned.layoutByPage?.[String(page)]);}
        expect(resolveScanCleanupProvisionalDocumentCanvasFromAccumulator(accumulator, 150, planned.options, true)?.widthPoints).toBe(612);
        owner.closeSource(requireDocumentRef('/docs/scan.pdf'));
    });
});

describe('browser OCR raster size', () => {
    it('renders a UserUnit page in user-space units, as desktop Poppler does', async () => {
        const {renderBrowserOcrRaster} = await import('@app/platform/browser-api/browserOcrRaster');
        vi.stubGlobal('document', {createElement: () => ({getContext: () => ({})})});
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        const renderedWidths: number[] = [];
        const userUnit = 10;
        const page = cast<Parameters<typeof renderBrowserOcrRaster>[0]>({
            getViewport: ({scale}: {scale: number}) => ({
                width: 612 * scale * userUnit,
                height: 792 * scale * userUnit,
                userUnit,
                scale,
                rotation: 0,
                transform: [
                    scale * userUnit,
                    0,
                    0,
                    -scale * userUnit,
                    0,
                    792 * scale * userUnit,
                ],
                clone: () => page.getViewport({scale}),
            }),
            render: ({viewport}: {viewport: {width: number}}) => {
                renderedWidths.push(viewport.width);
                return {promise: Promise.reject(new Error('rendered'))};
            },
        });

        // 85 dpi over a 612x792 unit page is about 723x935 pixels, under the
        // guard; scaled by UserUnit it was 7225x9350 and refused.
        await expect(renderBrowserOcrRaster(page, 85, new AbortController().signal)).rejects.toThrow('rendered');
        expect(renderedWidths).toEqual([612 * 85 / 72]);
    });
});

describe('browser OCR lanes', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function resolveLanes(
        navigatorFields: {
            hardwareConcurrency?: number;
            deviceMemory?: number;
        },
        ...args: Parameters<typeof import('@app/platform/browser-api/browserOcrEngineClient').resolveBrowserOcrLanes>
    ) {
        vi.stubGlobal('navigator', navigatorFields);
        const {resolveBrowserOcrLanes} = await import('@app/platform/browser-api/browserOcrEngineClient');
        return resolveBrowserOcrLanes(...args);
    }

    it('runs more than eight lanes on a many-core device with memory for them', async () => {
        expect(await resolveLanes({
            hardwareConcurrency: 32,
            deviceMemory: 8,
        })).toEqual({
            lanes: 21,
            preprocessLanes: 0,
        });
    });

    it('keeps one core free and stays within half the reported memory', async () => {
        expect((await resolveLanes({
            hardwareConcurrency: 12,
            deviceMemory: 8,
        })).lanes).toBe(11);
    });

    // A 300 DPI letter page with two 15 MB models: ~374 MiB a Tesseract lane, ~353 MiB a cleaning worker.
    const letter = [
        2_550 * 3_300,
        30_000_000,
    ] as const;

    it('gives cleaning as many workers as its lanes need, within the same memory', async () => {
        // Ten lanes would leave memory for one cleaning worker, which feeds two of them.
        expect(await resolveLanes({
            hardwareConcurrency: 32,
            deviceMemory: 8,
        }, ...letter, 'clean')).toEqual({
            lanes: 7,
            preprocessLanes: 4,
        });
        expect(await resolveLanes({
            hardwareConcurrency: 12,
            deviceMemory: 32,
        }, ...letter, 'clean')).toEqual({
            lanes: 10,
            preprocessLanes: 5,
        });
    });

    it('gives a polarity check a quarter of its lanes', async () => {
        expect(await resolveLanes({
            hardwareConcurrency: 10,
            deviceMemory: 8,
        }, ...letter, 'polarity-only')).toEqual({
            lanes: 8,
            preprocessLanes: 2,
        });
    });

    it('trades a lane for a second cleaning worker when memory is tight', async () => {
        // An unreported device: four lanes fit with one cleaning worker, which feeds two.
        expect(await resolveLanes({hardwareConcurrency: 8}, ...letter, 'clean')).toEqual({
            lanes: 3,
            preprocessLanes: 2,
        });
    });

    it('keeps a 4 GiB device to one lane', async () => {
        expect(await resolveLanes({
            hardwareConcurrency: 32,
            deviceMemory: 4,
        }, ...letter, 'clean')).toEqual({
            lanes: 1,
            preprocessLanes: 1,
        });
    });
});

describe('browser OCR worker WASM split', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('routes recognition and preprocessing to separate worker scripts so Tesseract workers never load scan-cleanup WASM', async () => {
        vi.resetModules();
        const spawned: Array<{
            url: string;
            terminated: boolean;
            listeners: Map<string, Set<(event: unknown) => void>>;
            messages: unknown[];
        }> = [];

        class FakeWorker {
            public readonly record: (typeof spawned)[number];
            public constructor(url: string | URL) {
                this.record = {
                    url: String(url),
                    terminated: false,
                    listeners: new Map(),
                    messages: [],
                };
                spawned.push(this.record);
            }
            public addEventListener(type: string, listener: (event: unknown) => void) {
                const set = this.record.listeners.get(type) ?? new Set();
                set.add(listener);
                this.record.listeners.set(type, set);
            }
            public removeEventListener(type: string, listener: (event: unknown) => void) {
                this.record.listeners.get(type)?.delete(listener);
            }
            public postMessage(message: {id: number; type: string}) {
                this.record.messages.push(message);
                queueMicrotask(() => {
                    const data = message.type === 'preprocess'
                        ? {
                            image: new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0]),
                            width: 1,
                            height: 1,
                        }
                        : {
                            passes: [{
                                stderr: '',
                                outputs: [new Uint8Array([37, 80, 68, 70, 45])],
                            }],
                        };
                    for (const listener of this.record.listeners.get('message') ?? []) {
                        listener({
                            data: {
                                id: message.id,
                                ok: true,
                                type: message.type,
                                data,
                            },
                        });
                    }
                });
            }
            public terminate() {
                this.record.terminated = true;
            }
        }

        vi.stubGlobal('Worker', FakeWorker);
        const {
            preprocessBrowserOcrRaster,
            runBrowserOcrEngine,
        } = await import('@app/platform/browser-api/browserOcrEngineClient');

        const cleaned = await preprocessBrowserOcrRaster({
            image: new Uint8Array([80, 54, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0, 0, 0]),
            mode: 'polarity-only',
            dpi: 150,
        }, new AbortController().signal);
        expect(cleaned.width).toBe(1);

        const recognized = await runBrowserOcrEngine({
            image: new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0]),
            models: ['eng'],
            passes: [{
                args: ['tesseract', '/work/page.ppm', '/work/out'],
                outputs: ['/work/out.pdf'],
            }],
        }, new AbortController().signal);
        expect(recognized.passes).toHaveLength(1);

        expect(spawned).toHaveLength(2);
        expect(spawned[0]!.url).toContain('browserOcrPreprocess.worker.ts');
        expect(spawned[1]!.url).toContain('browserOcrEngine.worker.ts');
        expect(spawned[0]!.url).not.toBe(spawned[1]!.url);
    });
});

describe('browser OCR request cancellation', () => {
    afterEach(() => {
        vi.resetModules();
    });

    it('releases the rendered tiles of a page that reaches a worker after its job was canceled', async () => {
        vi.resetModules();
        const {preprocessBrowserOcrRaster} = await import('@app/platform/browser-api/browserOcrEngineClient');
        const close = vi.fn();
        const controller = new AbortController();
        controller.abort(new DOMException('OCR was canceled', 'AbortError'));

        await expect(preprocessBrowserOcrRaster({
            image: {
                width: 1,
                height: 1,
                tiles: [{close}],
            } as never,
            mode: 'clean',
            dpi: 300,
        }, controller.signal)).rejects.toThrow('OCR was canceled');
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('browser OCR OPFS checkpoints and streaming finalization', () => {
    function createFakeOpfsPort() {
        const files = new Map<string, Uint8Array>();
        return {
            files,
            async list(dir: string) {
                const prefix = `${dir}/`;
                return [...new Set(
                    [...files.keys()]
                        .filter(path => path.startsWith(prefix))
                        .map(path => path.slice(prefix.length).split('/')[0]!),
                )];
            },
            async read(path: string) {
                const bytes = files.get(path);
                if (!bytes) {throw new DOMException(`Missing ${path}`, 'NotFoundError');}
                return bytes.slice();
            },
            async writeAtomic(path: string, bytes: Uint8Array) {
                files.set(path, bytes.slice());
            },
            async remove(path: string) {
                files.delete(path);
                const prefix = `${path}/`;
                for (const key of [...files.keys()]) {
                    if (key.startsWith(prefix)) {files.delete(key);}
                }
            },
        };
    }

    it('stages per-page checkpoints in OPFS, reads bounded sorted chunks, sweeps stale dirs, and cleans up', async () => {
        const {
            createBrowserOcrCheckpointStore,
            sweepStaleBrowserOcrCheckpoints,
        } = await import('@app/platform/browser-api/browserOcrCheckpoints');
        const port = createFakeOpfsPort();
        const staleCreatedAt = Date.now() - 25 * 60 * 60 * 1000;
        await port.writeAtomic(
            'ocr-checkpoints/stale-job/meta.json',
            new TextEncoder().encode(JSON.stringify({createdAt: staleCreatedAt})),
        );
        await port.writeAtomic('ocr-checkpoints/stale-job/page-1.pdf', new Uint8Array([1, 2, 3]));

        const store = await createBrowserOcrCheckpointStore(port, 'job-active');
        expect(store.storageKind).toBe('opfs');

        await sweepStaleBrowserOcrCheckpoints(port);
        expect(port.files.has('ocr-checkpoints/stale-job/page-1.pdf')).toBe(false);
        expect(port.files.has('ocr-checkpoints/job-active/meta.json')).toBe(true);

        // Stage pages out of order and verify sorted bounded chunk iteration.
        for (const pageNumber of [3, 1, 5, 2, 4]) {
            await store.stagePage({
                pageNumber,
                languages: ['eng'],
                pdf: new Uint8Array([37, 80, 68, 70, 45, pageNumber]),
                text: `page ${pageNumber}`,
                wordEdits: [],
                wordGeometry: {
                    rasterWidthPx: 100,
                    rasterHeightPx: 100,
                    words: [{
                        text: `word${pageNumber}`,
                        x: 10,
                        y: 10,
                        width: 20,
                        height: 12,
                    }],
                },
                diagnostics: [],
            });
        }
        expect(store.getPageCount()).toBe(5);
        expect(port.files.has('ocr-checkpoints/job-active/page-3.pdf')).toBe(true);
        expect(port.files.has('ocr-checkpoints/job-active/page-3.json')).toBe(true);

        const chunks: number[][] = [];
        for await (const chunk of store.iterateChunks({maxPages: 2})) {
            chunks.push(chunk.records.map(record => record.pageNumber));
            expect(chunk.pagePdfs).toHaveLength(chunk.records.length);
            chunk.records.forEach((record, index) => {
                expect(chunk.pagePdfs[index]![5]).toBe(record.pageNumber);
            });
        }
        expect(chunks).toEqual([[1, 2], [3, 4], [5]]);

        await store.cleanup();
        expect([...port.files.keys()]).toEqual([]);
    });

    it('latches to memory after OPFS hits QuotaExceededError, reads mixed OPFS + memory checkpoints, and aborts chunk iteration on signal', async () => {
        const {createBrowserOcrCheckpointStore} = await import('@app/platform/browser-api/browserOcrCheckpoints');
        const port = createFakeOpfsPort();
        let writes = 0;
        port.writeAtomic = async (path, bytes) => {
            writes += 1;
            // Write 1 = meta.json, write 2 = page-1.pdf, write 3 = page-1.json; page 2 hits quota.
            if (writes > 3) {throw new DOMException('Quota exceeded', 'QuotaExceededError');}
            port.files.set(path, bytes.slice());
        };
        const store = await createBrowserOcrCheckpointStore(port, 'job-quota');
        await store.stagePage({
            pageNumber: 1,
            languages: ['eng'],
            pdf: new Uint8Array([1, 2, 3]),
            text: 'one',
            wordEdits: [],
            wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
            diagnostics: [],
        });
        await store.stagePage({
            pageNumber: 2,
            languages: ['eng'],
            pdf: new Uint8Array([4, 5, 6]),
            text: 'two',
            wordEdits: [],
            wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
            diagnostics: [],
        });
        const writesAfterQuota = writes;
        await store.stagePage({
            pageNumber: 3,
            languages: ['eng'],
            pdf: new Uint8Array([7, 8, 9]),
            text: 'three',
            wordEdits: [],
            wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
            diagnostics: [],
        });
        // Page 1 stays in OPFS, page 2 tripped quota into memory, and page 3 skipped OPFS writes completely.
        expect(store.getPageCount()).toBe(3);
        expect(port.files.has('ocr-checkpoints/job-quota/page-1.pdf')).toBe(true);
        expect(port.files.has('ocr-checkpoints/job-quota/page-2.pdf')).toBe(false);
        expect(port.files.has('ocr-checkpoints/job-quota/page-3.pdf')).toBe(false);
        expect(writes).toBe(writesAfterQuota);

        // Mixed OPFS (page 1) + memory fallback (pages 2, 3) readback yields all 3 pages in order.
        const readBack: Array<{page: number; pdf: number[]}> = [];
        for await (const chunk of store.iterateChunks({maxPages: 2})) {
            chunk.records.forEach((record, index) => {
                readBack.push({page: record.pageNumber, pdf: [...chunk.pagePdfs[index]!]});
            });
        }
        expect(readBack).toEqual([
            {page: 1, pdf: [1, 2, 3]},
            {page: 2, pdf: [4, 5, 6]},
            {page: 3, pdf: [7, 8, 9]},
        ]);

        const controller = new AbortController();
        const yielded: number[] = [];
        await expect(async () => {
            for await (const chunk of store.iterateChunks({maxPages: 1, signal: controller.signal})) {
                yielded.push(...chunk.records.map(record => record.pageNumber));
                controller.abort(new DOMException('Canceled', 'AbortError'));
            }
        }).rejects.toThrow('Canceled');
        expect(yielded).toEqual([1]);

        await store.cleanup();
        expect(store.getPageCount()).toBe(0);
        expect([...port.files.keys()]).toEqual([]);
    });

    it('streams browser OCR finalization across bounded chunks and cleans up OPFS checkpoints on completion and abort', async () => {
        vi.resetModules();
        const opfs = createFakeOpfsPort();
        const appendChunks: Array<{base: number; pageNumbers: number[]; pdfCount: number}> = [];
        let abortAfterFirstChunk = false;
        const jobAbort = new AbortController();

        vi.doMock('@app/platform/browser-api/browserOcrEngineClient', () => ({
            resolveBrowserOcrLanes: () => ({
                lanes: 2,
                preprocessLanes: 1,
            }),
            preprocessBrowserOcrRaster: vi.fn(),
            runBrowserOcrEngine: vi.fn(async () => ({
                passes: [{
                    stderr: '',
                    outputs: [
                        new TextEncoder().encode('%PDF-1.5\n%%EOF\n'),
                        new TextEncoder().encode('level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\thello\n'),
                    ],
                }],
            })),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrModels', () => ({
            ensureBrowserOcrModel: vi.fn(async () => undefined),
            readCachedOcrModel: vi.fn(async () => new Uint8Array([1])),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrRaster', () => ({
            BROWSER_OCR_ANNOTATION_MODE: 1,
            getBrowserOcrRasterSize: () => ({width: 100, height: 100}),
            readPageSourceDpi: () => 150,
            renderBrowserOcrRaster: vi.fn(async () => ({image: new Uint8Array([80, 54, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0, 0, 0])})),
        }));
        vi.doMock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({
            runBrowserPageOpsWorkerRequest: vi.fn(async () => ({
                format: 'evb-pdf-ocr-text-visibility',
                schemaVersion: 3,
                pages: [],
            })),
        }));
        vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({
            loadBrowserPdfjsDocument: vi.fn(async () => ({
                getPage: vi.fn(async () => ({
                    getTextContent: async () => ({items: []}),
                    getViewport: () => ({width: 612, height: 792, userUnit: 1}),
                    getOperatorList: async () => ({fnArray: [], argsArray: []}),
                    cleanup: () => undefined,
                })),
                loadingTask: {destroy: vi.fn(async () => undefined)},
            })),
        }));
        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                stores: async () => ({durable: {port: opfs}, memory: {port: opfs}}),
                getDocumentRevision: async () => ({token: 'drt1:browser:doc:1'}),
                readableBlob: async () => new Blob([new Uint8Array(100)]),
                stageAppend: async (_ref: string, _token: string, fn: (file: unknown, base: number) => Promise<number | null>) => {
                    const length = await fn({}, 100);
                    return length === null ? null : 'lease-1';
                },
            },
        }));
        vi.doMock('@app/platform/browser/browserStorePort', () => ({
            appendPdfMutationsToStoreFile: vi.fn(async (_file: unknown, base: number, request: {
                instructions: {pages: Array<{pageNumber: number}>};
                pagePdfs: Uint8Array[];
            }) => {
                appendChunks.push({
                    base,
                    pageNumbers: request.instructions.pages.map(page => page.pageNumber),
                    pdfCount: request.pagePdfs.length,
                });
                if (abortAfterFirstChunk && appendChunks.length === 1) {
                    jobAbort.abort(new DOMException('Canceled mid-merge', 'AbortError'));
                }
                return {
                    pageCount: 20,
                    length: base + 50,
                    identityBindings: [],
                    sha256: String(appendChunks.length).padStart(64, 'a'),
                };
            }),
        }));

        try {
            const {runBrowserOcrJob} = await import('@app/platform/browser-api/browserOcrJob');
            const pages = Array.from({length: 20}, (_, index) => ({
                pageNumber: requirePageNumber(index + 1),
                languages: ['eng'],
            }));

            const outcome = await runBrowserOcrJob({
                sourceRef: requireDocumentRef('browser://documents/a/book.pdf'),
                pages,
                options: {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                signal: new AbortController().signal,
                emit: () => undefined,
            });
            expect(outcome.kind).toBe('written');
            if (outcome.kind === 'written') {
                expect(outcome.length).toBe(200);
                expect(outcome.sha256).toMatch(/^[a-f0-9]{64}$/u);
            }
            // 20 pages must finalize across two bounded chunks (16 + 4), chained by base offset.
            expect(appendChunks).toEqual([
                {base: 100, pageNumbers: Array.from({length: 16}, (_, i) => i + 1), pdfCount: 16},
                {base: 150, pageNumbers: [17, 18, 19, 20], pdfCount: 4},
            ]);
            // OPFS checkpoint directory must be cleanly removed after completion.
            expect([...opfs.files.keys()]).toEqual([]);

            // Abort between chunk 1 and chunk 2 must stop finalization and clean up OPFS checkpoints.
            appendChunks.length = 0;
            abortAfterFirstChunk = true;
            await expect(runBrowserOcrJob({
                sourceRef: requireDocumentRef('browser://documents/a/book.pdf'),
                pages,
                options: {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                signal: jobAbort.signal,
                emit: () => undefined,
            })).rejects.toThrow('Canceled mid-merge');
            expect(appendChunks).toHaveLength(1);
            expect([...opfs.files.keys()]).toEqual([]);
        } finally {
            for (const path of [
                '@app/platform/browser-api/browserOcrEngineClient',
                '@app/platform/browser-api/browserOcrModels',
                '@app/platform/browser-api/browserOcrRaster',
                '@app/platform/browser-api/browserPageOpsWorkerClient',
                '@app/platform/browser-api/loadBrowserPdfjsDocument',
                '@app/platform/browserDocumentStore',
                '@app/platform/browser/browserStorePort',
            ]) {vi.doUnmock(path);}
        }
    });
});
