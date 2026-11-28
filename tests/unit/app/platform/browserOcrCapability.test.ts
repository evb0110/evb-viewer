import {afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';
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
        const states = [{closed: false}, {closed: false}];
        const tiles = states.map((state) =>
            cast<ImageBitmap>({
                width: 1,
                height: 1,
                close() {
                    state.closed = true;
                },
            }),
        );
        vi.stubGlobal(
            'OffscreenCanvas',
            class {
                public width = 1;
                public height = 1;
            },
        );
        try {
            expect(() =>
                assembleBrowserPdfRasterPpm({
                    width: Number.MAX_SAFE_INTEGER,
                    height: 2,
                    tiles,
                }),
            ).toThrow(RangeError);
            expect(states.map((state) => state.closed)).toEqual([true, true]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('refuses OCR with its reason when the browser cannot run the engine', async () => {
        vi.stubGlobal('Worker', undefined);
        try {
            const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(browserOcrCapability.getLanguages()).resolves.toEqual([]);
            await expect(
                browserOcrCapability.createSearchablePdf(
                    requireDocumentRef('browser://documents/a/in.pdf'),
                    [
                        {
                            pageNumber: requirePageNumber(1),
                            languages: ['eng'],
                        },
                    ],
                    requireRequestId('request-2'),
                ),
            ).resolves.toMatchObject({
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
            const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');
            const {AVAILABLE_OCR_LANGUAGES} = await import('@contracts/ocrLanguages');

            const languages = await browserOcrCapability.getLanguages();
            expect(languages.map((language) => language.code)).toEqual(AVAILABLE_OCR_LANGUAGES.map((language) => language.code));
            expect(new Set(languages.map((language) => language.modelState))).toEqual(new Set(['missing']));
        });

        it('refuses a language outside the registry', async () => {
            const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');

            await expect(
                browserOcrCapability.createSearchablePdf(
                    requireDocumentRef('browser://documents/a/in.pdf'),
                    [
                        {
                            pageNumber: requirePageNumber(1),
                            languages: ['xyz'],
                        },
                    ],
                    requireRequestId('request-3'),
                ),
            ).resolves.toMatchObject({
                started: false,
                error: 'Unsupported OCR language: xyz',
                errorEnvelope: {code: 'OCR_INVALID_PAYLOAD'},
            });
        });
    });

    it('reports unknown jobs and results without touching documents', async () => {
        const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');

        await expect(browserOcrCapability.cancel(requireRequestId('request-5'))).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        await expect(
            browserOcrCapability.acknowledgeResultFile(
                requireRequestId('request-5'),
                requireDocumentRef('browser://documents/b/result.pdf'),
            ),
        ).resolves.toEqual({cleaned: false});
    });

    it(
        'wires the browser platform to the browser OCR capability lazily',
        async () => {
            vi.spyOn(console, 'error').mockImplementation(() => undefined);
            vi.stubGlobal('Worker', function Worker() {});
            vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});
            try {
                const {browserPlatformApi} = await import('@app/platform/browserPlatformApi');
                const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');

                await expect(browserPlatformApi.ocr.getLanguages()).resolves.toEqual(await browserOcrCapability.getLanguages());
                await expect(browserPlatformApi.ocr.cancel(requireRequestId('request-wired-1'))).resolves.toEqual({
                    canceled: false,
                    reason: 'not-found',
                });
            } finally {
                vi.unstubAllGlobals();
            }
        },
        browserPlatformWiringTimeoutMs,
    );
});

interface IPendingRender {
    input: IRenderBrowserScanCleanupPreviewInput;
    resolve: (rendering: IBrowserScanCleanupPreviewRendering) => void;
}

const renders = {pending: [] as IPendingRender[]};
const destroyed = {count: 0};

/** The source boundary and the job's renders, settled by each test. */
function mockScanCleanupPreviewSource() {
    vi.doMock('@app/platform/browser-api/browserScanCleanupJob', () => ({
        renderBrowserScanCleanupWorkspacePreview: (input: IRenderBrowserScanCleanupPreviewInput) =>
            new Promise<IBrowserScanCleanupPreviewRendering>((resolve, reject) => {
                input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
                renders.pending.push({
                    input,
                    resolve,
                });
            }),
    }));
    vi.doMock('@app/platform/browserDocumentStore', () => ({
        getBrowserDocumentFileName: () => 'scan.pdf',
        browserDocumentStore: {
            assertDocumentRevisionCurrent: vi.fn(async () => undefined),
            read: vi.fn(async () => new Uint8Array([1, 2, 3])),
            readableBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
            readableRevision: vi.fn(async (_ref: string, expected?: {token?: string}) => ({
                blob: new Blob([new Uint8Array([1, 2, 3])]),
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
            pages: [1, 2].map((pageNumber) => ({
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
    vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({
        loadBrowserPdfjsDocument: vi.fn(async () => ({
            numPages: 2,
            loadingTask: {
                destroy: vi.fn(async () => {
                    destroyed.count += 1;
                }),
            },
        })),
    }));
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
    for (let turn = 0; turn < 10; turn += 1) {
        await Promise.resolve();
    }
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
        ]) {
            vi.doUnmock(path);
        }
    });

    async function loadCapability() {
        return (await import('@app/platform/browser-api/browserScanCleanupCapability')).browserScanCleanupCapability;
    }

    it.each([
        {job: 'detection', retire: false},
        {job: 'conversion', retire: false},
        {job: 'detection', retire: true},
        {job: 'conversion', retire: true},
    ] as const)('answers a late browser $job subscriber with the terminal state or retirement (retire=$retire)', async ({job, retire}) => {
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
        const stop = listen((state) => {
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
                expect(events).toContainEqual(
                    expect.objectContaining({
                        jobId: started.jobId,
                        status: 'retired',
                    }),
                );
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

        await expect(
            capability.preview(
                request({
                    visible: false,
                    pageNumber: requirePageNumber(2),
                }),
            ),
        ).resolves.toEqual({canceled: true});

        renders.pending[0]!.resolve(rendering(1));
        await expect(visible).resolves.toMatchObject({pageNumber: 1});
        expect(renders.pending).toHaveLength(1);
    });

    it('refines a base that is still rendering once it lands, without canceling the detail', async () => {
        const capability = await loadCapability();
        const base = request();
        const basePreview = capability.preview(base);
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        const detail = capability.preview(
            request({
                visible: false,
                detail: {
                    viewports: {
                        full: {
                            xNormalized: 0,
                            yNormalized: 0,
                            widthNormalized: 0.5,
                            heightNormalized: 0.5,
                            rotationDegrees: 0,
                        },
                    },
                    outputMode: 'bw',
                },
            }),
        );
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
        const [firstResult, secondResult] = await Promise.all([first, second]);
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
            const results = await Promise.all([first, second]);
            expect(renders.pending.map((render) => render.input.request.pageNumber)).toEqual([visible.pageNumber]);
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
            await Promise.allSettled([first, second]);
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
        await expect(
            capability.preview(
                request({
                    visible: false,
                    detail: {
                        viewports: {
                            full: {
                                xNormalized: 0,
                                yNormalized: 0,
                                widthNormalized: 1,
                                heightNormalized: 1,
                                rotationDegrees: 0,
                            },
                        },
                        outputMode: 'bw',
                    },
                }),
            ),
        ).rejects.toThrow('rebuild the base preview');
    });

    it("cancels its own owner's work and releases the source when the raw cache is invalidated", async () => {
        const capability = await loadCapability();
        const visible = capability.preview(request());
        await vi.waitFor(() => expect(renders.pending).toHaveLength(1));
        await expect(
            capability.cancelPreview({
                sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
                ownerId: 'someone-else',
                documentRevision: 'revision-1',
            }),
        ).resolves.toBe(false);
        await expect(
            capability.cancelPreview({
                sourcePdfPath: requireDocumentRef('/docs/scan.pdf'),
                ownerId: 'owner-1',
                documentRevision: 'revision-1',
                invalidateRawCache: true,
            }),
        ).resolves.toBe(true);
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
        ]) {
            vi.doUnmock(path);
        }
    });

    it.each([2, 1025])('retains the selected page evidence for an unmatched preview of %s pages', async (pageCount) => {
        vi.resetModules();
        const {createMemoryScanCleanupDetectionResultStore} =
            await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
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
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({
            createIndexedDbScanCleanupDetectionResultStore: async () => store,
        }));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: pageCount})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({
            runBrowserScanCleanupDetection: async ({resultStore}: {resultStore: typeof store}) => {
                await resultStore.append(record);
                return {
                    resultStore,
                    results: [record],
                    blankPageCount: 0,
                };
            },
        }));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const {narrowScanCleanupPreviewRequestToPage} = await import('@contracts/scan-cleanup/narrowScanCleanupPreviewRequestToPage');
        const owner = createBrowserScanCleanupDetectionOwner();
        const detection = request({
            options: {
                ...scanCleanupPreviewOptions,
                matchPageSize: false,
                pageOverrides: {'2': cast({rotationDegrees: 90})},
            },
        });
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
        const {createMemoryScanCleanupDetectionResultStore} =
            await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const store = createMemoryScanCleanupDetectionResultStore(2000, 1);
        const result = (
            pageNumber: number,
            classification: IScanCleanupDetectionResult['classification'],
        ): IScanCleanupDetectionResult => ({
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
        store.forEachChunk = (callback) =>
            walk(async (rows, firstPageNumber) => {
                await callback(rows, firstPageNumber);
                if (!reconciled) {
                    reconciled = true;
                    await store.replace(1, result(1, 'single-uncut-page'));
                    await store.replace(2000, result(2000, 'single-uncut-page'));
                }
            });
        const running = Promise.withResolvers<undefined>();
        const entered = Promise.withResolvers<undefined>();
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({
            createIndexedDbScanCleanupDetectionResultStore: async () => store,
        }));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: 2000})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({
            runBrowserScanCleanupDetection: async () => {
                entered.resolve(undefined);
                await running.promise;
                return {
                    resultStore: store,
                    results: [],
                    blankPageCount: 0,
                };
            },
        }));
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
        const {createMemoryScanCleanupDetectionResultStore} =
            await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const result = (classification: 'two-page-spread' | 'single-uncut-page') =>
            cast<IScanCleanupDetectionResult>({
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
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({
            createIndexedDbScanCleanupDetectionResultStore: async (count: number) => createMemoryScanCleanupDetectionResultStore(count),
        }));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: 2000})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({
            runBrowserScanCleanupDetection: async ({
                resultStore,
            }: {
                resultStore: ReturnType<typeof createMemoryScanCleanupDetectionResultStore>;
            }) => {
                liveStore = resultStore;
                await resultStore.append(result('two-page-spread'));
                await running.promise;
                return {
                    resultStore,
                    results: [],
                    blankPageCount: 0,
                };
            },
        }));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const owner = createBrowserScanCleanupDetectionOwner();
        const preview = request({
            options: {
                ...scanCleanupPreviewOptions,
                outputMode: 'bw',
            },
        });
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
        const {createMemoryScanCleanupDetectionResultStore} =
            await import('@evb/scan-cleanup/core/createMemoryScanCleanupDetectionResultStore');
        const {
            addScanCleanupDocumentCanvasPage,
            createScanCleanupDocumentCanvasAccumulator,
            resolveScanCleanupProvisionalDocumentCanvasFromAccumulator,
        } = await import('@evb/scan-cleanup/core/policy/documentCanvas');
        const spread = (pageNumber: number) =>
            cast<IScanCleanupDetectionResult>({
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
        vi.doMock('@app/platform/browser-api/createIndexedDbScanCleanupDetectionResultStore', () => ({
            createIndexedDbScanCleanupDetectionResultStore: async (count: number) => createMemoryScanCleanupDetectionResultStore(count),
        }));
        vi.doMock('@app/platform/browser-api/browserScanCleanupSources', () => ({
            borrowBrowserScanCleanupSource: () => ({
                opened: Promise.resolve({pageSizes: Array.from({length: pageCount})}),
                release() {},
            }),
            awaitScanCleanupSource: (promise: Promise<unknown>) => promise,
        }));
        vi.doMock('@app/platform/browser-api/runBrowserScanCleanupDetection', () => ({
            runBrowserScanCleanupDetection: async ({
                resultStore,
            }: {
                resultStore: ReturnType<typeof createMemoryScanCleanupDetectionResultStore>;
            }) => {
                for (let page = 1; page <= pageCount; page += 1) {
                    await resultStore.append(spread(page));
                }
                return {
                    resultStore,
                    results: [],
                    blankPageCount: 0,
                };
            },
        }));
        const {createBrowserScanCleanupDetectionOwner} = await import('@app/platform/browser-api/createBrowserScanCleanupDetectionOwner');
        const owner = createBrowserScanCleanupDetectionOwner();
        const preview = request({
            options: {
                ...scanCleanupPreviewOptions,
                outputMode: 'bw',
            },
        });
        const job = await owner.detectAll(preview);
        await vi.waitFor(async () => expect((await owner.getDetectionJobState(job.jobId, preview))?.status).toBe('completed'));
        // The renderer keeps only its last 256 layouts.
        const kept = Object.fromEntries(
            Array.from({length: 256}, (_, index) => [String(pageCount - 255 + index), 'two-page-spread' as const]),
        );

        const planned = await owner.resolvePreviewPagePlan({
            ...preview,
            layoutByPage: kept,
            layoutDetectionComplete: true,
        });

        expect(Object.keys(planned.layoutByPage ?? {})).toHaveLength(pageCount);
        const accumulator = createScanCleanupDocumentCanvasAccumulator();
        for (let page = 1; page <= pageCount; page += 1) {
            addScanCleanupDocumentCanvasPage(
                accumulator,
                {
                    pageNumber: page,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 1224,
                    heightPoints: 792,
                    rotation: 0,
                },
                planned.options,
                planned.layoutByPage?.[String(page)],
            );
        }
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
                transform: [scale * userUnit, 0, 0, -scale * userUnit, 0, 792 * scale * userUnit],
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
        expect(renderedWidths).toEqual([(612 * 85) / 72]);
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
        expect(
            await resolveLanes({
                hardwareConcurrency: 32,
                deviceMemory: 8,
            }),
        ).toEqual({
            lanes: 21,
            preprocessLanes: 0,
        });
    });

    it('keeps one core free and stays within half the reported memory', async () => {
        expect(
            (
                await resolveLanes({
                    hardwareConcurrency: 12,
                    deviceMemory: 8,
                })
            ).lanes,
        ).toBe(11);
    });

    // A 300 DPI letter page with two 15 MB models: ~374 MiB a Tesseract lane, ~353 MiB a cleaning worker.
    const letter = [2_550 * 3_300, 30_000_000] as const;

    it('gives cleaning as many workers as its lanes need, within the same memory', async () => {
        // Ten lanes would leave memory for one cleaning worker, which feeds two of them.
        expect(
            await resolveLanes(
                {
                    hardwareConcurrency: 32,
                    deviceMemory: 8,
                },
                ...letter,
                'clean',
            ),
        ).toEqual({
            lanes: 7,
            preprocessLanes: 4,
        });
        expect(
            await resolveLanes(
                {
                    hardwareConcurrency: 12,
                    deviceMemory: 32,
                },
                ...letter,
                'clean',
            ),
        ).toEqual({
            lanes: 10,
            preprocessLanes: 5,
        });
    });

    it('gives a polarity check a quarter of its lanes', async () => {
        expect(
            await resolveLanes(
                {
                    hardwareConcurrency: 10,
                    deviceMemory: 8,
                },
                ...letter,
                'polarity-only',
            ),
        ).toEqual({
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
        expect(
            await resolveLanes(
                {
                    hardwareConcurrency: 32,
                    deviceMemory: 4,
                },
                ...letter,
                'clean',
            ),
        ).toEqual({
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
                    const data =
                        message.type === 'preprocess'
                            ? {
                                  image: new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0]),
                                  width: 1,
                                  height: 1,
                              }
                            : {
                                  passes: [
                                      {
                                          stderr: '',
                                          outputs: [new Uint8Array([37, 80, 68, 70, 45])],
                                      },
                                  ],
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
        const {preprocessBrowserOcrRaster, runBrowserOcrEngine} = await import('@app/platform/browser-api/browserOcrEngineClient');

        const cleaned = await preprocessBrowserOcrRaster(
            {
                image: new Uint8Array([80, 54, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0, 0, 0]),
                mode: 'polarity-only',
                dpi: 150,
            },
            new AbortController().signal,
        );
        expect(cleaned.width).toBe(1);

        const recognized = await runBrowserOcrEngine(
            {
                image: new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0]),
                models: ['eng'],
                passes: [
                    {
                        args: ['tesseract', '/work/page.ppm', '/work/out'],
                        outputs: ['/work/out.pdf'],
                    },
                ],
            },
            new AbortController().signal,
        );
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

        await expect(
            preprocessBrowserOcrRaster(
                {
                    image: {
                        width: 1,
                        height: 1,
                        tiles: [{close}],
                    } as never,
                    mode: 'clean',
                    dpi: 300,
                },
                controller.signal,
            ),
        ).rejects.toThrow('OCR was canceled');
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
                return [
                    ...new Set(
                        [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]!),
                    ),
                ];
            },
            async read(path: string) {
                const bytes = files.get(path);
                if (!bytes) {
                    throw new DOMException(`Missing ${path}`, 'NotFoundError');
                }
                return bytes.slice();
            },
            async writeAtomic(path: string, bytes: Uint8Array) {
                files.set(path, bytes.slice());
            },
            async remove(path: string) {
                files.delete(path);
                const prefix = `${path}/`;
                for (const key of [...files.keys()]) {
                    if (key.startsWith(prefix)) {
                        files.delete(key);
                    }
                }
            },
        };
    }

    it('stages per-page checkpoints in OPFS, reads bounded sorted chunks, sweeps stale dirs, and cleans up', async () => {
        const {createBrowserOcrCheckpointStore, sweepStaleBrowserOcrCheckpoints} =
            await import('@app/platform/browser-api/browserOcrCheckpoints');
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
                    words: [
                        {
                            text: `word${pageNumber}`,
                            x: 10,
                            y: 10,
                            width: 20,
                            height: 12,
                        },
                    ],
                },
                diagnostics: [],
            });
        }
        expect(store.getPageCount()).toBe(5);
        expect(port.files.has('ocr-checkpoints/job-active/page-3.pdf')).toBe(true);
        expect(port.files.has('ocr-checkpoints/job-active/page-3.json')).toBe(true);

        const chunks: number[][] = [];
        for await (const chunk of store.iterateChunks({maxPages: 2})) {
            chunks.push(chunk.records.map((record) => record.pageNumber));
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
            if (writes > 3) {
                throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
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
                yielded.push(...chunk.records.map((record) => record.pageNumber));
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
                passes: [
                    {
                        stderr: '',
                        outputs: [
                            new TextEncoder().encode('%PDF-1.5\n%%EOF\n'),
                            new TextEncoder().encode(
                                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\thello\n',
                            ),
                        ],
                    },
                ],
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
            appendPdfMutationsToStoreFile: vi.fn(
                async (
                    _file: unknown,
                    base: number,
                    request: {
                        instructions: {pages: Array<{pageNumber: number}>};
                        pagePdfs: Uint8Array[];
                    },
                ) => {
                    appendChunks.push({
                        base,
                        pageNumbers: request.instructions.pages.map((page) => page.pageNumber),
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
                },
            ),
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
            await expect(
                runBrowserOcrJob({
                    sourceRef: requireDocumentRef('browser://documents/a/book.pdf'),
                    pages,
                    options: {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                    signal: jobAbort.signal,
                    emit: () => undefined,
                }),
            ).rejects.toThrow('Canceled mid-merge');
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
            ]) {
                vi.doUnmock(path);
            }
        }
    });

    it('P0-1: discards appended OCR tail when canceled during cleanup awaits and preserves file length and manifest for subsequent Save/OCR', async () => {
        vi.resetModules();
        vi.stubGlobal('Worker', function Worker() {});
        vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});

        const {BrowserDocumentStore} = await import('@app/platform/browser/browserDocumentRepository');
        const {browserPublication} = await import('@app/platform/browser/browserPublication');
        const {createMemoryStorePort} = await import('@app/platform/browser/browserStorePort');
        const port = createMemoryStorePort();
        const store = {port, publication: browserPublication};
        const repo = new BrowserDocumentStore();
        vi.spyOn(repo, 'stores').mockResolvedValue({durable: store, memory: store});

        const baseBytes = new TextEncoder().encode('%PDF-1.7\noriginal-body\n%%EOF\n');
        const sourceRef = await repo.createStoredDocument('abort-cleanup.pdf', baseBytes, {
            mimeType: 'application/pdf',
            kind: 'working',
        });
        const entry = repo.openEntries().find((candidate) => candidate.ref === sourceRef)!;
        const manifestPath = entry.doc!.path('manifest.json');
        const currentFilePath = entry.doc!.path(entry.doc!.snapshot().current!.file);
        const manifestBefore = new TextDecoder().decode(await port.read(manifestPath));
        const lengthBefore = (await port.open(currentFilePath)).size();

        const enteredDestroy = Promise.withResolvers<void>();
        const releaseDestroy = Promise.withResolvers<void>();
        let destroyPauseArmed = true;

        vi.doMock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: repo}));
        vi.doMock('@app/platform/browser-api/browserOcrEngineClient', () => ({
            resolveBrowserOcrLanes: () => ({lanes: 1, preprocessLanes: 0}),
            preprocessBrowserOcrRaster: vi.fn(),
            runBrowserOcrEngine: vi.fn(async () => ({
                passes: [
                    {
                        stderr: '',
                        outputs: [
                            new TextEncoder().encode('%PDF-1.5\n%%EOF\n'),
                            new TextEncoder().encode(
                                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\thello\n',
                            ),
                        ],
                    },
                ],
            })),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrModels', () => ({
            canStoreBrowserOcrModels: () => true,
            hasCachedOcrModel: vi.fn(async () => true),
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
                loadingTask: {
                    destroy: vi.fn(async () => {
                        if (destroyPauseArmed) {
                            destroyPauseArmed = false;
                            enteredDestroy.resolve();
                            await releaseDestroy.promise;
                        }
                    }),
                },
            })),
        }));
        vi.doMock('@app/platform/browser/browserStorePort', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@app/platform/browser/browserStorePort')>();
            return {
                ...actual,
                appendPdfMutationsToStoreFile: vi.fn(
                    async (file: {writeAt(offset: number, bytes: Uint8Array): Promise<void>}, base: number) => {
                        const tail = new TextEncoder().encode('\n%ocr-incremental-tail\n%%EOF\n');
                        await file.writeAt(base, tail);
                        return {
                            pageCount: 1,
                            length: base + tail.byteLength,
                            identityBindings: [],
                            sha256: 'a'.repeat(64),
                        };
                    },
                ),
            };
        });

        let stop: (() => void) | undefined;
        let stop2: (() => void) | undefined;
        let activeReq1: ReturnType<typeof requireRequestId> | undefined;
        let completed1Promise: Promise<import('@contracts/electronApiOcr').IOcrCompleteResult> | undefined;
        let completed2Promise: Promise<import('@contracts/electronApiOcr').IOcrCompleteResult> | undefined;
        let capabilityRef: typeof import('@app/platform/browser-api/browserOcrCapability').browserOcrCapability | undefined;
        try {
            const {browserOcrCapability, commitBrowserOcrResult} = await import('@app/platform/browser-api/browserOcrCapability');
            capabilityRef = browserOcrCapability;
            const completed = Promise.withResolvers<import('@contracts/electronApiOcr').IOcrCompleteResult>();
            completed1Promise = completed.promise;
            stop = browserOcrCapability.onComplete((result) => completed.resolve(result));
            const req1 = requireRequestId('ocr-abort-cleanup-1');
            activeReq1 = req1;
            const started = await browserOcrCapability.createSearchablePdf(
                sourceRef,
                [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                req1,
                {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
            );
            expect(started.started).toBe(true);

            // Wait until stageAppend has written the tail and browserOcrJob is awaiting cleanup (pdf.loadingTask.destroy).
            await enteredDestroy.promise;
            expect(await (await port.open(currentFilePath)).size()).toBeGreaterThan(await lengthBefore);

            // Cancel during cleanup await, then let cleanup finish.
            await expect(browserOcrCapability.cancel(req1)).resolves.toEqual({canceled: true});
            releaseDestroy.resolve();

            const terminal = await completed.promise;
            stop();
            stop = undefined;
            completed1Promise = undefined;
            activeReq1 = undefined;
            expect(terminal.success).toBe(false);
            expect(terminal.errors).toEqual(['OCR was canceled']);

            // The uncommitted tail MUST have been discarded and truncated back to the exact base length.
            expect(await (await port.open(currentFilePath)).size()).toBe(await lengthBefore);
            expect(new TextDecoder().decode(await port.read(manifestPath))).toBe(manifestBefore);

            // Next OCR on the same document must succeed and commit cleanly.
            const completed2 = Promise.withResolvers<import('@contracts/electronApiOcr').IOcrCompleteResult>();
            completed2Promise = completed2.promise;
            stop2 = browserOcrCapability.onComplete((result) => completed2.resolve(result));
            const req2 = requireRequestId('ocr-abort-cleanup-2');
            const started2 = await browserOcrCapability.createSearchablePdf(
                sourceRef,
                [{pageNumber: requirePageNumber(1), languages: ['eng']}],
                req2,
                {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
            );
            expect(started2.started).toBe(true);
            const terminal2 = await completed2.promise;
            stop2();
            stop2 = undefined;
            completed2Promise = undefined;
            expect(terminal2.success).toBe(true);
            if (!terminal2.success) {
                throw new Error('expected second OCR to succeed');
            }
            await expect(commitBrowserOcrResult(sourceRef, terminal2.pdfPath, terminal2.sourceDocumentRevisionToken)).resolves.toBe(true);
            await expect(
                browserOcrCapability.acknowledgeResultFile(req2, terminal2.pdfPath, sourceRef, terminal2.sourceDocumentRevisionToken),
            ).resolves.toEqual({
                cleaned: true,
            });
            expect(await (await port.open(currentFilePath)).size()).toBeGreaterThan(await lengthBefore);
        } finally {
            releaseDestroy.resolve();
            if (activeReq1 && capabilityRef) {
                await capabilityRef.cancel(activeReq1).catch(() => undefined);
            }
            await completed1Promise?.catch(() => undefined);
            await completed2Promise?.catch(() => undefined);
            stop?.();
            stop2?.();
            vi.unstubAllGlobals();
            for (const path of [
                '@app/platform/browserDocumentStore',
                '@app/platform/browser-api/browserOcrEngineClient',
                '@app/platform/browser-api/browserOcrModels',
                '@app/platform/browser-api/browserOcrRaster',
                '@app/platform/browser-api/browserPageOpsWorkerClient',
                '@app/platform/browser-api/loadBrowserPdfjsDocument',
                '@app/platform/browser/browserStorePort',
            ]) {
                vi.doUnmock(path);
            }
        }
    });

    it('P0-1: refuses a second concurrent OCR request on the same document through apply and acknowledgement without disturbing the active job', async () => {
        vi.resetModules();
        vi.stubGlobal('Worker', function Worker() {});
        vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});

        const releaseJobA = Promise.withResolvers<void>();
        const jobAStarted = Promise.withResolvers<void>();
        const discardStarted = Promise.withResolvers<void>();
        const releaseDiscard = Promise.withResolvers<void>();
        let pauseNextDiscard = false;
        const commitAppend = vi.fn(async () => undefined);
        const discardAppend = vi.fn(async () => {
            if (pauseNextDiscard) {
                pauseNextDiscard = false;
                discardStarted.resolve();
                await releaseDiscard.promise;
            }
        });
        let leaseCounter = 0;

        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                commitAppend,
                discardAppend,
            },
        }));
        vi.doMock('@app/platform/browser-api/browserOcrModels', () => ({
            canStoreBrowserOcrModels: () => true,
            hasCachedOcrModel: vi.fn(async () => true),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrJob', () => ({
            runBrowserOcrJob: vi.fn(async () => {
                const lease = `lease-${++leaseCounter}`;
                if (leaseCounter === 1) {
                    jobAStarted.resolve();
                    await releaseJobA.promise;
                }
                return {
                    kind: 'written' as const,
                    lease,
                    length: 150,
                    sha256: 'b'.repeat(64),
                    sourceRevisionToken: 'drt1:browser:doc:1',
                    errors: [],
                    diagnostics: [],
                };
            }),
        }));

        let stopA: (() => void) | undefined;
        let stopE: (() => void) | undefined;
        let pendingA: Promise<import('@contracts/electronApiOcr').IOcrCompleteResult> | undefined;
        let pendingE: Promise<import('@contracts/electronApiOcr').IOcrCompleteResult> | undefined;
        let pendingAck: Promise<unknown> | undefined;
        try {
            const {browserOcrCapability, commitBrowserOcrResult} = await import('@app/platform/browser-api/browserOcrCapability');
            const docRef = requireDocumentRef('browser://documents/concurrent-doc/in.pdf');
            const page = [{pageNumber: requirePageNumber(1), languages: ['eng']}];

            const completedA = Promise.withResolvers<import('@contracts/electronApiOcr').IOcrCompleteResult>();
            pendingA = completedA.promise;
            stopA = browserOcrCapability.onComplete((result) => {
                if (result.requestId === 'ocr-doc-a') {
                    completedA.resolve(result);
                }
            });

            const startA = await browserOcrCapability.createSearchablePdf(docRef, page, requireRequestId('ocr-doc-a'));
            expect(startA.started).toBe(true);
            await jobAStarted.promise;

            // Concurrent request on the same document while Job A is running MUST be refused.
            const startB = await browserOcrCapability.createSearchablePdf(docRef, page, requireRequestId('ocr-doc-b'));
            expect(startB.started).toBe(false);
            expect(startB.errorEnvelope?.code).toBe('OCR_QUEUE_BACKPRESSURE');
            expect(startB.errorEnvelope?.retryable).toBe(true);

            // Let Job A finish staging its result.
            releaseJobA.resolve();
            const terminalA = await completedA.promise;
            stopA();
            stopA = undefined;
            pendingA = undefined;
            expect(terminalA.success).toBe(true);
            if (!terminalA.success) {
                throw new Error('expected Job A to succeed');
            }

            // Before apply/ack, a second request on the same document MUST still be refused.
            const startC = await browserOcrCapability.createSearchablePdf(docRef, page, requireRequestId('ocr-doc-c'));
            expect(startC.started).toBe(false);
            expect(startC.errorEnvelope?.code).toBe('OCR_QUEUE_BACKPRESSURE');

            // Job A's apply must still commit Job A's exact lease undisturbed.
            await expect(commitBrowserOcrResult(docRef, terminalA.pdfPath, terminalA.sourceDocumentRevisionToken)).resolves.toBe(true);
            expect(commitAppend).toHaveBeenCalledWith(docRef, terminalA.sourceDocumentRevisionToken, 'lease-1');

            // Before acknowledgement, a second request is still refused.
            const startD = await browserOcrCapability.createSearchablePdf(docRef, page, requireRequestId('ocr-doc-d'));
            expect(startD.started).toBe(false);

            // While acknowledgement's discardAppend is still in flight, same-document requests remain refused
            // and a duplicate acknowledgeResultFile returns cleaned: false.
            pauseNextDiscard = true;
            const ackPromise = browserOcrCapability.acknowledgeResultFile(
                requireRequestId('ocr-doc-a'),
                terminalA.pdfPath,
                docRef,
                terminalA.sourceDocumentRevisionToken,
            );
            pendingAck = ackPromise;
            await discardStarted.promise;
            const startDuringDiscard = await browserOcrCapability.createSearchablePdf(
                docRef,
                page,
                requireRequestId('ocr-doc-during-discard'),
            );
            expect(startDuringDiscard.started).toBe(false);
            expect(startDuringDiscard.errorEnvelope?.code).toBe('OCR_QUEUE_BACKPRESSURE');
            await expect(
                browserOcrCapability.acknowledgeResultFile(
                    requireRequestId('ocr-doc-a'),
                    terminalA.pdfPath,
                    docRef,
                    terminalA.sourceDocumentRevisionToken,
                ),
            ).resolves.toEqual({cleaned: false});

            // Once discardAppend settles, acknowledgement completes and frees the document for the next OCR job.
            releaseDiscard.resolve();
            await expect(ackPromise).resolves.toEqual({cleaned: true});
            pendingAck = undefined;
            const completedE = Promise.withResolvers<import('@contracts/electronApiOcr').IOcrCompleteResult>();
            pendingE = completedE.promise;
            stopE = browserOcrCapability.onComplete((result) => {
                if (result.requestId === 'ocr-doc-e') {
                    completedE.resolve(result);
                }
            });
            const startE = await browserOcrCapability.createSearchablePdf(docRef, page, requireRequestId('ocr-doc-e'));
            expect(startE.started).toBe(true);
            const terminalE = await completedE.promise;
            stopE();
            stopE = undefined;
            pendingE = undefined;
            expect(terminalE.success).toBe(true);
            if (!terminalE.success) {
                throw new Error('expected Job E to succeed');
            }
            // A delayed apply from acknowledged Job A MUST NOT commit Job E's staged lease on the same revision.
            await expect(commitBrowserOcrResult(docRef, terminalA.pdfPath, terminalA.sourceDocumentRevisionToken)).rejects.toThrow(
                'The OCR result does not belong to this document',
            );
            expect(commitAppend).toHaveBeenCalledTimes(1);
            // Job E's own receipt commits Job E's lease cleanly.
            await expect(commitBrowserOcrResult(docRef, terminalE.pdfPath, terminalE.sourceDocumentRevisionToken)).resolves.toBe(true);
            expect(commitAppend).toHaveBeenLastCalledWith(docRef, terminalE.sourceDocumentRevisionToken, 'lease-2');
            await browserOcrCapability.acknowledgeResultFile(
                requireRequestId('ocr-doc-e'),
                terminalE.pdfPath,
                docRef,
                terminalE.sourceDocumentRevisionToken,
            );
        } finally {
            releaseJobA.resolve();
            releaseDiscard.resolve();
            await pendingA?.catch(() => undefined);
            await pendingAck?.catch(() => undefined);
            await pendingE?.catch(() => undefined);
            stopA?.();
            stopE?.();
            vi.unstubAllGlobals();
            for (const path of [
                '@app/platform/browserDocumentStore',
                '@app/platform/browser-api/browserOcrModels',
                '@app/platform/browser-api/browserOcrJob',
            ]) {
                vi.doUnmock(path);
            }
        }
    });

    it('P0-3: completes ordinary no-OPFS/quota jobs via memory fallback, but fails job-fatally and drains sibling lanes when aggregate memory ceiling is exceeded', async () => {
        vi.resetModules();
        const {createBrowserOcrCheckpointStore, getBrowserOcrMemoryFallbackBytes} =
            await import('@app/platform/browser-api/browserOcrCheckpoints');
        const {recognizeOcrPages} = await import('@ocr-core/recognizeOcrPages');

        const makePagePdf = (size: number) => {
            const bytes = new Uint8Array(size);
            bytes.set(new TextEncoder().encode('%PDF-1.5\n'));
            return bytes;
        };
        const tsvBytes = new TextEncoder().encode(
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\tok\n',
        );

        // (a) Ordinary OPFS-unavailable job still succeeds cleanly via memory fallback.
        const noOpfsStore = await createBrowserOcrCheckpointStore(null, 'ordinary-no-opfs');
        expect(noOpfsStore.storageKind).toBe('memory');
        const ordinaryResult = await recognizeOcrPages({
            pages: [
                {pageNumber: 1, languages: ['eng']},
                {pageNumber: 2, languages: ['eng']},
            ],
            extractionDpi: 150,
            sourceDpiByPage: new Map(),
            options: {},
            lanes: 2,
            signal: new AbortController().signal,
            renderPage: async () => ({image: new Uint8Array([1]), width: 10, height: 10}),
            runEngine: async () => ({passes: [{stderr: '', outputs: [makePagePdf(64), tsvBytes]}]}),
            prepareEarlyPrintModels: async () => undefined,
            readModel: async () => new Uint8Array([1]),
            acceptPage: (page) => noOpfsStore.stagePage(page),
        });
        expect(ordinaryResult.recognizedCount).toBe(2);
        expect(ordinaryResult.errors.items).toEqual([]);
        expect(noOpfsStore.getPageCount()).toBe(2);
        await noOpfsStore.cleanup();

        // (b) Two concurrent jobs competing for the same aggregate memory fallback ceiling:
        // Job 1 holds part of the ceiling; Job 2 stages a small page first, then breaches the ceiling
        // on page 3 while page 2 is still in-flight on the sibling lane.
        const ceilingBytes = 1_000;
        const job1Store = await createBrowserOcrCheckpointStore(null, 'concurrent-job-1', {maxMemoryFallbackBytes: ceilingBytes});
        const job2Store = await createBrowserOcrCheckpointStore(null, 'concurrent-job-2', {maxMemoryFallbackBytes: ceilingBytes});
        const siblingStarted = Promise.withResolvers<void>();
        const releaseSibling = Promise.withResolvers<void>();
        const events: string[] = [];
        let siblingSawAbort = false;
        let job2Promise: Promise<unknown> | undefined;
        try {
            await job1Store.stagePage({
                pageNumber: 1,
                languages: ['eng'],
                pdf: makePagePdf(500),
                text: 'held-by-job-1',
                wordEdits: [],
                wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
                diagnostics: [],
            });
            const job1Bytes = getBrowserOcrMemoryFallbackBytes();
            expect(job1Bytes).toBeGreaterThanOrEqual(500);

            let job2BytesAfterPage1 = 0;
            job2Promise = recognizeOcrPages({
                pages: [
                    {pageNumber: 1, languages: ['eng']},
                    {pageNumber: 2, languages: ['eng']},
                    {pageNumber: 3, languages: ['eng']},
                ],
                extractionDpi: 150,
                sourceDpiByPage: new Map(),
                options: {},
                lanes: 2,
                signal: new AbortController().signal,
                renderPage: async (pageNumber, _dpi, pageSignal) => {
                    if (pageNumber === 2) {
                        siblingStarted.resolve();
                        pageSignal.addEventListener(
                            'abort',
                            () => {
                                siblingSawAbort = true;
                                events.push('sibling-aborted');
                            },
                            {once: true},
                        );
                        await releaseSibling.promise;
                        events.push('sibling-drained');
                        pageSignal.throwIfAborted();
                    }
                    return {image: new Uint8Array([pageNumber]), width: 10, height: 10};
                },
                runEngine: async (req) => {
                    const pageNumber = req.image[0]!;
                    if (pageNumber === 1) {
                        return {passes: [{stderr: '', outputs: [makePagePdf(80), tsvBytes]}]};
                    }
                    // Ensure sibling lane is actively in flight before page 3 breaches the ceiling.
                    await siblingStarted.promise;
                    return {passes: [{stderr: '', outputs: [makePagePdf(400), tsvBytes]}]};
                },
                prepareEarlyPrintModels: async () => undefined,
                readModel: async () => new Uint8Array([1]),
                acceptPage: async (page) => {
                    await job2Store.stagePage(page);
                    if (page.pageNumber === 1) {
                        job2BytesAfterPage1 = getBrowserOcrMemoryFallbackBytes();
                    }
                },
            }).finally(async () => {
                events.push('cleanup-start');
                await job2Store.cleanup();
            });

            // Wait for sibling lane to observe fatal cancellation, then allow sibling lane to finish draining.
            await vi.waitFor(() => expect(siblingSawAbort).toBe(true));
            expect(job2BytesAfterPage1).toBeGreaterThan(job1Bytes);
            expect(events).not.toContain('cleanup-start');
            releaseSibling.resolve();

            await expect(job2Promise).rejects.toThrow(/storage|memory|checkpoint/iu);
            expect(events).toEqual(['sibling-aborted', 'sibling-drained', 'cleanup-start']);
            // Job 2 must clear its staged page and release its charge while Job 1's charge remains intact.
            expect(job2Store.getPageCount()).toBe(0);
            expect(getBrowserOcrMemoryFallbackBytes()).toBe(job1Bytes);

            // Once Job 1 cleans up too, reserved bytes are completely freed.
            await job1Store.cleanup();
            expect(getBrowserOcrMemoryFallbackBytes()).toBe(0);
        } finally {
            releaseSibling.resolve();
            await job2Promise?.catch(() => undefined);
            await job2Store.cleanup();
            await job1Store.cleanup();
        }

        // Verify consume: true keeps each chunk's memory charge live until the caller finishes its async append,
        // frees both OPFS quota files and memory fallback bytes chunk-by-chunk, and releases on early iterator close.
        const mixedOpfs = createFakeOpfsPort();
        let mixedWrites = 0;
        mixedOpfs.writeAtomic = async (path, bytes) => {
            mixedWrites += 1;
            // meta.json (1) + page-1.pdf (2) + page-1.json (3) succeed in OPFS; page 2 hits quota into memory.
            if (mixedWrites > 3) {
                throw new DOMException('Quota exceeded', 'QuotaExceededError');
            }
            mixedOpfs.files.set(path, bytes.slice());
        };
        const mixedStore = await createBrowserOcrCheckpointStore(mixedOpfs, 'consume-drain', {maxMemoryFallbackBytes: ceilingBytes});
        try {
            await mixedStore.stagePage({
                pageNumber: 1,
                languages: ['eng'],
                pdf: makePagePdf(200),
                text: 'opfs-page',
                wordEdits: [],
                wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
                diagnostics: [],
            });
            await mixedStore.stagePage({
                pageNumber: 2,
                languages: ['eng'],
                pdf: makePagePdf(300),
                text: 'memory-page',
                wordEdits: [],
                wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
                diagnostics: [],
            });
            const reservedBeforeConsume = getBrowserOcrMemoryFallbackBytes();
            expect(reservedBeforeConsume).toBeGreaterThanOrEqual(300);
            expect(mixedOpfs.files.has('ocr-checkpoints/consume-drain/page-1.pdf')).toBe(true);

            const observedDuringYield: Array<{pages: number[]; memBytes: number; opfsHasPage1: boolean}> = [];
            for await (const chunk of mixedStore.iterateChunks({maxPages: 1, consume: true})) {
                observedDuringYield.push({
                    pages: chunk.records.map((r) => r.pageNumber),
                    memBytes: getBrowserOcrMemoryFallbackBytes(),
                    opfsHasPage1: mixedOpfs.files.has('ocr-checkpoints/consume-drain/page-1.pdf'),
                });
            }
            // Chunk 1 (OPFS) deletes page-1.pdf right after read (before yield) so OPFS quota is freed
            // before the first append writes, while Chunk 2 (memory) keeps memory bytes charged during yield
            // until the consumer's append settles.
            expect(observedDuringYield).toEqual([
                {pages: [1], memBytes: reservedBeforeConsume, opfsHasPage1: false},
                {pages: [2], memBytes: reservedBeforeConsume, opfsHasPage1: false},
            ]);
            expect(getBrowserOcrMemoryFallbackBytes()).toBe(0);
        } finally {
            await mixedStore.cleanup();
        }

        // Breaking out of iterateChunks({consume: true}) early must still release the yielded chunk's memory bytes.
        const earlyCloseStore = await createBrowserOcrCheckpointStore(null, 'early-close', {maxMemoryFallbackBytes: ceilingBytes});
        try {
            await earlyCloseStore.stagePage({
                pageNumber: 1,
                languages: ['eng'],
                pdf: makePagePdf(200),
                text: 'p1',
                wordEdits: [],
                wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
                diagnostics: [],
            });
            await earlyCloseStore.stagePage({
                pageNumber: 2,
                languages: ['eng'],
                pdf: makePagePdf(200),
                text: 'p2',
                wordEdits: [],
                wordGeometry: {rasterWidthPx: 10, rasterHeightPx: 10, words: []},
                diagnostics: [],
            });
            const initialTwoPagesBytes = getBrowserOcrMemoryFallbackBytes();
            for await (const _chunk of earlyCloseStore.iterateChunks({maxPages: 1, consume: true})) {
                break;
            }
            expect(getBrowserOcrMemoryFallbackBytes()).toBeLessThan(initialTwoPagesBytes);
            expect(earlyCloseStore.getPageCount()).toBe(1);
        } finally {
            await earlyCloseStore.cleanup();
        }
        expect(getBrowserOcrMemoryFallbackBytes()).toBe(0);

        // Fatal error must also cancel sibling early-print model preparation via laneSignal.
        let earlyPrintSignalAborted = false;
        const earlyPrintStarted = Promise.withResolvers<void>();
        const releaseEarlyPrint = Promise.withResolvers<void>();
        const longSTsv = new TextEncoder().encode(
            'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
                Array.from({length: 20}, (_, index) => `5\t1\t1\t1\t1\t${index + 1}\t${10 + index * 30}\t10\t20\t12\t95\tfeftum`).join(
                    '\n',
                ) +
                '\n',
        );
        const {OcrFatalJobError} = await import('@ocr-core/recognizeOcrPages');
        let fatalEarlyPrintPromise: Promise<unknown> | undefined;
        try {
            fatalEarlyPrintPromise = recognizeOcrPages({
                pages: [
                    {pageNumber: 1, languages: ['lat']},
                    {pageNumber: 2, languages: ['eng']},
                ],
                extractionDpi: 150,
                sourceDpiByPage: new Map(),
                options: {},
                lanes: 2,
                signal: new AbortController().signal,
                renderPage: async () => ({image: new Uint8Array([1]), width: 10, height: 10}),
                runEngine: async (req) => ({
                    passes: [{stderr: '', outputs: [makePagePdf(64), req.models.includes('lat') ? longSTsv : tsvBytes]}],
                }),
                prepareEarlyPrintModels: async (earlySignal) => {
                    earlyPrintStarted.resolve();
                    earlySignal?.addEventListener(
                        'abort',
                        () => {
                            earlyPrintSignalAborted = true;
                        },
                        {once: true},
                    );
                    await releaseEarlyPrint.promise;
                    earlySignal?.throwIfAborted();
                },
                readModel: async () => new Uint8Array([1]),
                acceptPage: async (page) => {
                    if (page.pageNumber === 2) {
                        await earlyPrintStarted.promise;
                        throw new OcrFatalJobError('checkpoint ceiling exceeded', {code: 'OCR_DOCUMENT_TOO_LARGE'});
                    }
                },
            });
            await vi.waitFor(() => expect(earlyPrintSignalAborted).toBe(true));
            releaseEarlyPrint.resolve();
            await expect(fatalEarlyPrintPromise).rejects.toThrow('checkpoint ceiling exceeded');
        } finally {
            releaseEarlyPrint.resolve();
            await fatalEarlyPrintPromise?.catch(() => undefined);
        }
    });

    it('P0-3: surfaces OCR_DOCUMENT_TOO_LARGE and leaves document manifest untouched when memory fallback ceiling is exceeded through browserOcrCapability', async () => {
        vi.resetModules();
        vi.stubGlobal('Worker', function Worker() {});
        vi.stubGlobal('caches', {open: () => Promise.resolve({match: () => Promise.resolve(undefined)})});

        const stageAppend = vi.fn();
        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                stores: async () => ({durable: null, memory: null}),
                getDocumentRevision: async () => ({token: 'drt1:browser:doc:1'}),
                readableBlob: async () => new Blob([new Uint8Array(100)]),
                stageAppend,
                discardAppend: vi.fn(async () => undefined),
            },
        }));
        vi.doMock('@app/platform/browser-api/browserOcrCheckpoints', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@app/platform/browser-api/browserOcrCheckpoints')>();
            return {
                ...actual,
                createBrowserOcrCheckpointStore: (port: Parameters<typeof actual.createBrowserOcrCheckpointStore>[0], jobId?: string) =>
                    actual.createBrowserOcrCheckpointStore(port, jobId, {maxMemoryFallbackBytes: 400}),
            };
        });
        vi.doMock('@app/platform/browser-api/browserOcrEngineClient', () => ({
            resolveBrowserOcrLanes: () => ({lanes: 2, preprocessLanes: 0}),
            preprocessBrowserOcrRaster: vi.fn(),
            runBrowserOcrEngine: vi.fn(async () => {
                const bigPdf = new Uint8Array(500);
                bigPdf.set(new TextEncoder().encode('%PDF-1.5\n'));
                return {
                    passes: [
                        {
                            stderr: '',
                            outputs: [
                                bigPdf,
                                new TextEncoder().encode(
                                    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\tok\n',
                                ),
                            ],
                        },
                    ],
                };
            }),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrModels', () => ({
            canStoreBrowserOcrModels: () => true,
            hasCachedOcrModel: vi.fn(async () => true),
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

        try {
            const {browserOcrCapability} = await import('@app/platform/browser-api/browserOcrCapability');
            const {getBrowserOcrMemoryFallbackBytes} = await import('@app/platform/browser-api/browserOcrCheckpoints');
            const completed = Promise.withResolvers<import('@contracts/electronApiOcr').IOcrCompleteResult>();
            const stop = browserOcrCapability.onComplete((result) => completed.resolve(result));

            const started = await browserOcrCapability.createSearchablePdf(
                requireDocumentRef('browser://documents/ceiling-doc/in.pdf'),
                [
                    {pageNumber: requirePageNumber(1), languages: ['eng']},
                    {pageNumber: requirePageNumber(2), languages: ['eng']},
                ],
                requireRequestId('ocr-ceiling-1'),
                {renderDpi: 150, supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
            );
            expect(started.started).toBe(true);
            const terminal = await completed.promise;
            stop();

            expect(terminal.success).toBe(false);
            expect(terminal.errorEnvelope?.code).toBe('OCR_DOCUMENT_TOO_LARGE');
            expect(terminal.errors[0]).toMatch(/storage quota.*memory/iu);
            expect(stageAppend).not.toHaveBeenCalled();
            expect(getBrowserOcrMemoryFallbackBytes()).toBe(0);
        } finally {
            vi.unstubAllGlobals();
            for (const path of [
                '@app/platform/browserDocumentStore',
                '@app/platform/browser-api/browserOcrCheckpoints',
                '@app/platform/browser-api/browserOcrEngineClient',
                '@app/platform/browser-api/browserOcrModels',
                '@app/platform/browser-api/browserOcrRaster',
                '@app/platform/browser-api/browserPageOpsWorkerClient',
                '@app/platform/browser-api/loadBrowserPdfjsDocument',
            ]) {
                vi.doUnmock(path);
            }
        }
    });

    it('O-8: recycles browser OCR workers cleanly between pages once retained WASM linear memory exceeds the tier cap', async () => {
        vi.resetModules();
        const MIB = 1024 * 1024;
        const spawned: Array<{
            terminated: boolean;
            listeners: Map<string, Set<(event: unknown) => void>>;
            messages: number;
        }> = [];
        const reportedBytesQueue = [256 * MIB, 400 * MIB, 200 * MIB];

        class FakeOcrWorker {
            public readonly record: (typeof spawned)[number];
            public constructor() {
                this.record = {
                    terminated: false,
                    listeners: new Map(),
                    messages: 0,
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
                this.record.messages += 1;
                const wasmMemoryBytes = reportedBytesQueue.shift() ?? 0;
                queueMicrotask(() => {
                    for (const listener of this.record.listeners.get('message') ?? []) {
                        listener({
                            data: {
                                id: message.id,
                                ok: true,
                                type: message.type,
                                wasmMemoryBytes,
                                data: {
                                    passes: [{stderr: '', outputs: [new Uint8Array([37, 80, 68, 70, 45])]}],
                                },
                            },
                        });
                    }
                });
            }
            public terminate() {
                this.record.terminated = true;
            }
        }

        vi.stubGlobal('Worker', FakeOcrWorker);
        vi.stubGlobal('navigator', {deviceMemory: 4, hardwareConcurrency: 4});
        try {
            const {
                BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_DEFAULT,
                BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY,
                BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_MOBILE,
                resolveBrowserOcrWasmHeapRecycleBytes,
                runBrowserOcrEngine,
            } = await import('@app/platform/browser-api/browserOcrEngineClient');

            expect(resolveBrowserOcrWasmHeapRecycleBytes({mobile: true})).toBe(BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_MOBILE);
            expect(resolveBrowserOcrWasmHeapRecycleBytes({deviceMemory: 4})).toBe(BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY);
            expect(resolveBrowserOcrWasmHeapRecycleBytes({lowMemory: true, deviceMemory: 8})).toBe(
                BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY,
            );
            expect(resolveBrowserOcrWasmHeapRecycleBytes({deviceMemory: 8})).toBe(BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_DEFAULT);
            expect(resolveBrowserOcrWasmHeapRecycleBytes()).toBe(BROWSER_OCR_WASM_HEAP_RECYCLE_BYTES_LOW_MEMORY);

            const makePayload = () => ({
                image: new Uint8Array([80, 53, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0]),
                models: ['eng' as const],
                passes: [{models: ['eng' as const], args: ['/work/page.ppm', '/work/out', '-l', 'eng'], outputs: ['/work/out.pdf']}],
            });

            // Page 1 (256 MiB <= 384 MiB cap): succeeds and keeps worker 1 warm.
            const page1 = await runBrowserOcrEngine(makePayload(), new AbortController().signal);
            expect(page1.passes).toHaveLength(1);
            expect(spawned).toHaveLength(1);
            expect(spawned[0]!.terminated).toBe(false);

            // An uncorrelated frame with an oversized wasmMemoryBytes must be ignored and never recycle the idle worker.
            for (const listener of spawned[0]!.listeners.get('message') ?? []) {
                listener({
                    data: {
                        id: 999_999,
                        ok: true,
                        type: 'recognize',
                        wasmMemoryBytes: 1024 * MIB,
                        data: {passes: []},
                    },
                });
            }
            expect(spawned[0]!.terminated).toBe(false);

            // Page 2 (foldout: 400 MiB > 384 MiB cap): reuses worker 1, succeeds without aborting, then recycles worker 1 cleanly.
            const page2 = await runBrowserOcrEngine(makePayload(), new AbortController().signal);
            expect(page2.passes).toHaveLength(1);
            expect(spawned).toHaveLength(1);
            expect(spawned[0]!.messages).toBe(2);
            expect(spawned[0]!.terminated).toBe(true);

            // Page 3 (200 MiB <= 384 MiB cap): spawns a fresh worker 2 and stays warm.
            const page3 = await runBrowserOcrEngine(makePayload(), new AbortController().signal);
            expect(page3.passes).toHaveLength(1);
            expect(spawned).toHaveLength(2);
            expect(spawned[1]!.messages).toBe(1);
            expect(spawned[1]!.terminated).toBe(false);
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });

    it('O-11: bounds browser OCR model downloads and page probing to 2-4 concurrency while preserving exact page order and abort cancellation', async () => {
        vi.resetModules();
        const {resolveBrowserOcrPrepConcurrency} = await import('@app/platform/browser-api/browserOcrJob');
        expect(resolveBrowserOcrPrepConcurrency({mobile: true, hardwareConcurrency: 8, deviceMemory: 8})).toBe(2);
        expect(resolveBrowserOcrPrepConcurrency({lowMemory: true, hardwareConcurrency: 12, deviceMemory: 8})).toBe(2);
        expect(resolveBrowserOcrPrepConcurrency({deviceMemory: 4, hardwareConcurrency: 16})).toBe(2);
        expect(resolveBrowserOcrPrepConcurrency({deviceMemory: 8, hardwareConcurrency: 4})).toBe(2);
        expect(resolveBrowserOcrPrepConcurrency({deviceMemory: 8, hardwareConcurrency: 6})).toBe(3);
        expect(resolveBrowserOcrPrepConcurrency({deviceMemory: 8, hardwareConcurrency: 16})).toBe(4);

        // Exercise runBrowserOcrJob on a constrained 4 GiB host (concurrency = 2) with 6 models and 8 pages.
        vi.resetModules();
        vi.stubGlobal('navigator', {deviceMemory: 4, hardwareConcurrency: 16});

        let activeModels = 0;
        let peakModels = 0;
        let activeProbes = 0;
        let peakProbes = 0;
        const appendedPageOrders: number[][] = [];
        const recognizedStartOrder: number[] = [];
        const cleanedPages: number[] = [];
        let evenPageDone = new Map<number, PromiseWithResolvers<void>>();
        const resetProbeGates = () => {
            evenPageDone = new Map([2, 4, 6, 8].map((pageNumber) => [pageNumber, Promise.withResolvers<void>()] as const));
        };
        resetProbeGates();

        vi.doMock('@app/platform/browser-api/browserOcrEngineClient', () => ({
            resolveBrowserOcrLanes: () => ({lanes: 1, preprocessLanes: 0}),
            preprocessBrowserOcrRaster: vi.fn(),
            runBrowserOcrEngine: vi.fn(async () => ({
                passes: [
                    {
                        stderr: '',
                        outputs: [
                            new TextEncoder().encode('%PDF-1.5\n%%EOF\n'),
                            new TextEncoder().encode(
                                'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t10\t20\t12\t95\tok\n',
                            ),
                        ],
                    },
                ],
            })),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrModels', () => ({
            ensureBrowserOcrModel: vi.fn(
                async (
                    code: string,
                    opts?: {
                        signal?: AbortSignal;
                        onProgress?: (progress: {
                            languageCode: string;
                            receivedBytes: number;
                            totalBytes: number;
                            attempt: number;
                            maxAttempts: number;
                            retrying: boolean;
                        }) => void;
                    },
                ) => {
                    opts?.signal?.throwIfAborted();
                    activeModels += 1;
                    peakModels = Math.max(peakModels, activeModels);
                    try {
                        opts?.onProgress?.({
                            languageCode: code,
                            receivedBytes: 1_000_000,
                            totalBytes: 2_000_000,
                            attempt: 1,
                            maxAttempts: 3,
                            retrying: false,
                        });
                        for (let turn = 0; turn < 4; turn += 1) {
                            await Promise.resolve();
                        }
                        opts?.onProgress?.({
                            languageCode: code,
                            receivedBytes: 2_000_000,
                            totalBytes: 2_000_000,
                            attempt: 1,
                            maxAttempts: 3,
                            retrying: false,
                        });
                    } finally {
                        activeModels -= 1;
                    }
                },
            ),
            readCachedOcrModel: vi.fn(async () => new Uint8Array([1])),
        }));
        vi.doMock('@app/platform/browser-api/browserOcrRaster', () => ({
            BROWSER_OCR_ANNOTATION_MODE: 1,
            getBrowserOcrRasterSize: () => ({width: 100, height: 100}),
            readPageSourceDpi: () => 150,
            renderBrowserOcrRaster: vi.fn(async (page: {pageNumber?: number}) => {
                if (typeof page.pageNumber === 'number') {
                    recognizedStartOrder.push(page.pageNumber);
                }
                return {image: new Uint8Array([80, 54, 10, 49, 32, 49, 10, 50, 53, 53, 10, 0, 0, 0])};
            }),
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
                getPage: vi.fn(async (pageNumber: number) => ({
                    pageNumber,
                    getTextContent: async () => {
                        activeProbes += 1;
                        peakProbes = Math.max(peakProbes, activeProbes);
                        try {
                            // Deterministically finish each even page before its preceding odd page.
                            if (pageNumber % 2 === 1) {
                                await evenPageDone.get(pageNumber + 1)?.promise;
                            } else {
                                for (let turn = 0; turn < 4; turn += 1) {
                                    await Promise.resolve();
                                }
                                evenPageDone.get(pageNumber)?.resolve();
                            }
                            return {items: []};
                        } finally {
                            activeProbes -= 1;
                        }
                    },
                    getViewport: () => ({width: 612, height: 792, userUnit: 1}),
                    getOperatorList: async () => ({fnArray: [], argsArray: []}),
                    cleanup: () => {
                        cleanedPages.push(pageNumber);
                    },
                })),
                loadingTask: {destroy: vi.fn(async () => undefined)},
            })),
        }));
        vi.doMock('@app/platform/browserDocumentStore', () => ({
            browserDocumentStore: {
                stores: async () => ({durable: null, memory: null}),
                getDocumentRevision: async () => ({token: 'drt1:browser:doc:1'}),
                readableBlob: async () => new Blob([new Uint8Array(100)]),
                stageAppend: async (_ref: string, _token: string, fn: (file: unknown, base: number) => Promise<number | null>) => {
                    const length = await fn({}, 100);
                    return length === null ? null : 'lease-1';
                },
            },
        }));
        vi.doMock('@app/platform/browser/browserStorePort', () => ({
            appendPdfMutationsToStoreFile: vi.fn(
                async (_file: unknown, base: number, request: {instructions: {pages: Array<{pageNumber: number}>}}) => {
                    appendedPageOrders.push(request.instructions.pages.map((page) => page.pageNumber));
                    return {
                        pageCount: request.instructions.pages.length,
                        length: base + 50,
                        identityBindings: [],
                        sha256: 'a'.repeat(64),
                    };
                },
            ),
        }));

        try {
            const {runBrowserOcrJob} = await import('@app/platform/browser-api/browserOcrJob');
            const languages = ['eng', 'fra', 'deu', 'spa', 'ita', 'por'];
            const pages = Array.from({length: 8}, (_, index) => ({
                pageNumber: requirePageNumber(index + 1),
                languages: [languages[index % languages.length]!],
            }));

            const modelProgressEvents: Array<{code: string; receivedBytes: number; totalBytes: number}> = [];
            const outcome = await runBrowserOcrJob({
                sourceRef: requireDocumentRef('browser://documents/o11/book.pdf'),
                pages,
                options: {supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                signal: new AbortController().signal,
                emit: (progress) => {
                    if (progress.phase === 'model-prep' && progress.modelDownload) {
                        modelProgressEvents.push({
                            code: progress.modelDownload.languageCode,
                            receivedBytes: progress.modelDownload.receivedBytes,
                            totalBytes: progress.modelDownload.totalBytes,
                        });
                    }
                },
            });
            expect(outcome.kind).toBe('written');
            expect(peakModels).toBe(2);
            expect(peakProbes).toBe(2);
            // Recognition start order on a single lane directly proves exact probe queue ordering (not checkpoint sort).
            expect(recognizedStartOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(appendedPageOrders).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);
            // Concurrent multi-model progress stays focused on one model at a time with its exact totalBytes and monotonic bytes.
            expect(modelProgressEvents.length).toBeGreaterThan(2);
            const seenFinishedModels = new Set<string>();
            for (let i = 0; i < modelProgressEvents.length; i += 1) {
                const current = modelProgressEvents[i]!;
                expect(current.totalBytes).toBe(2_000_000);
                expect(seenFinishedModels.has(current.code)).toBe(false);
                if (i > 0) {
                    const prev = modelProgressEvents[i - 1]!;
                    if (prev.code === current.code) {
                        expect(current.receivedBytes).toBeGreaterThanOrEqual(prev.receivedBytes);
                    } else {
                        seenFinishedModels.add(prev.code);
                    }
                }
            }

            // Higher-tier host (8 GiB, 12 cores) scales bounded concurrency up to 4.
            vi.stubGlobal('navigator', {deviceMemory: 8, hardwareConcurrency: 12});
            peakModels = 0;
            peakProbes = 0;
            recognizedStartOrder.length = 0;
            appendedPageOrders.length = 0;
            resetProbeGates();
            const highTierOutcome = await runBrowserOcrJob({
                sourceRef: requireDocumentRef('browser://documents/o11/book.pdf'),
                pages,
                options: {supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                signal: new AbortController().signal,
                emit: () => undefined,
            });
            expect(highTierOutcome.kind).toBe('written');
            expect(peakModels).toBe(4);
            expect(peakProbes).toBe(4);
            expect(recognizedStartOrder).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(appendedPageOrders).toEqual([[1, 2, 3, 4, 5, 6, 7, 8]]);

            // P1: A hung PDF.js probe on lane 1 must not block cancellation or sibling error propagation / teardown.
            cleanedPages.length = 0;
            const destroySpy = vi.fn(async () => undefined);
            const abortController = new AbortController();
            const probedCount = {value: 0};
            const stuckPage1 = new Promise<never>(() => undefined);
            vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({
                loadBrowserPdfjsDocument: vi.fn(async () => ({
                    getPage: vi.fn(async (pageNumber: number) => {
                        probedCount.value += 1;
                        return {
                            pageNumber,
                            getTextContent: async () => {
                                if (pageNumber === 1) {
                                    return stuckPage1;
                                }
                                if (pageNumber === 2) {
                                    abortController.abort(new DOMException('Stopped probing', 'AbortError'));
                                }
                                return {items: []};
                            },
                            getViewport: () => ({width: 612, height: 792, userUnit: 1}),
                            getOperatorList: async () => ({fnArray: [], argsArray: []}),
                            cleanup: () => {
                                cleanedPages.push(pageNumber);
                            },
                        };
                    }),
                    loadingTask: {destroy: destroySpy},
                })),
            }));
            vi.resetModules();
            vi.stubGlobal('navigator', {deviceMemory: 4, hardwareConcurrency: 4});
            const {runBrowserOcrJob: runAbortJob} = await import('@app/platform/browser-api/browserOcrJob');
            await expect(
                runAbortJob({
                    sourceRef: requireDocumentRef('browser://documents/o11/abort.pdf'),
                    pages,
                    options: {supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                    signal: abortController.signal,
                    emit: () => undefined,
                }),
            ).rejects.toThrow('Stopped probing');
            expect(probedCount.value).toBeLessThan(pages.length);
            expect(cleanedPages.length).toBe(probedCount.value);
            expect(destroySpy).toHaveBeenCalledOnce();

            // P2: Sibling error while another lane hangs in getOperatorList must fail immediately and reach teardown.
            const destroyErrorSpy = vi.fn(async () => undefined);
            vi.doMock('@app/platform/browser-api/loadBrowserPdfjsDocument', () => ({
                loadBrowserPdfjsDocument: vi.fn(async () => ({
                    getPage: vi.fn(async (pageNumber: number) => ({
                        pageNumber,
                        getTextContent: async () => ({items: []}),
                        getViewport: () => ({width: 612, height: 792, userUnit: 1}),
                        getOperatorList: async () => {
                            if (pageNumber === 1) {
                                return new Promise<never>(() => undefined);
                            }
                            throw new Error('Operator list exploded');
                        },
                        cleanup: () => undefined,
                    })),
                    loadingTask: {destroy: destroyErrorSpy},
                })),
            }));
            vi.resetModules();
            vi.stubGlobal('navigator', {deviceMemory: 4, hardwareConcurrency: 4});
            const {runBrowserOcrJob: runSiblingErrorJob} = await import('@app/platform/browser-api/browserOcrJob');
            await expect(
                runSiblingErrorJob({
                    sourceRef: requireDocumentRef('browser://documents/o11/sibling-err.pdf'),
                    pages,
                    options: {supersessionPolicy: 'replace-all', replaceAllAcknowledged: true},
                    signal: new AbortController().signal,
                    emit: () => undefined,
                }),
            ).rejects.toThrow('Operator list exploded');
            expect(destroyErrorSpy).toHaveBeenCalledOnce();

            // P2: Canceling ensureBrowserOcrModel while Cache Storage lookup is pending must never start fetch(),
            // and an immediate retry must not inherit the canceled attempt's abort reason or queue behind its Web Lock.
            vi.doUnmock('@app/platform/browser-api/browserOcrModels');
            vi.resetModules();
            const cacheLookup1 = Promise.withResolvers<Response | undefined>();
            let matchCall = 0;
            const fetchSpy = vi.fn();
            vi.stubGlobal('fetch', fetchSpy);
            vi.stubGlobal('caches', {
                open: async () => ({
                    match: () => {
                        matchCall += 1;
                        return matchCall === 1 ? cacheLookup1.promise : Promise.resolve(new Response(new Uint8Array([1])));
                    },
                    put: async () => undefined,
                }),
            });
            const lockChains = new Map<string, Promise<void>>();
            vi.stubGlobal('navigator', {
                locks: {
                    request: async (name: string, _opts: unknown, callback: () => Promise<void>) => {
                        const prev = lockChains.get(name) ?? Promise.resolve();
                        const release = Promise.withResolvers<void>();
                        lockChains.set(name, release.promise);
                        await prev;
                        try {
                            return await callback();
                        } finally {
                            release.resolve();
                        }
                    },
                },
            });
            const {ensureBrowserOcrModel} = await import('@app/platform/browser-api/browserOcrModels');
            const downloadAbort = new AbortController();
            const pendingDownload = ensureBrowserOcrModel('eng', {signal: downloadAbort.signal});
            await Promise.resolve();
            downloadAbort.abort(new DOMException('Canceled before fetch', 'AbortError'));
            await expect(pendingDownload).rejects.toThrow('Canceled before fetch');
            // Immediate retry while cacheLookup1 is still unresolved must acquire the released Web Lock and succeed cleanly.
            await expect(ensureBrowserOcrModel('eng', {signal: new AbortController().signal})).resolves.toBeUndefined();
            cacheLookup1.resolve(undefined);
            for (let turn = 0; turn < 6; turn += 1) {
                await Promise.resolve();
            }
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
            for (const path of [
                '@app/platform/browser-api/browserOcrEngineClient',
                '@app/platform/browser-api/browserOcrModels',
                '@app/platform/browser-api/browserOcrRaster',
                '@app/platform/browser-api/browserPageOpsWorkerClient',
                '@app/platform/browser-api/loadBrowserPdfjsDocument',
                '@app/platform/browserDocumentStore',
                '@app/platform/browser/browserStorePort',
            ]) {
                vi.doUnmock(path);
            }
            vi.resetModules();
        }
    });
});
