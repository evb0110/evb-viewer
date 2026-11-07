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
    vi.doMock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
        assertDocumentRevisionCurrent: vi.fn(async () => undefined),
        read: vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ])),
    }}));
    vi.doMock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: vi.fn(async () => ({
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
    }))}));
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
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
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
        ]) vi.doUnmock(path);
    });

    async function loadCapability() {
        return (await import('@app/platform/browser-api/browserScanCleanupCapability')).browserScanCleanupCapability;
    }

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
        ]) vi.doUnmock(path);
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
            for (let page = 1; page <= pageCount; page += 1) await resultStore.append(spread(page));
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
        for (let page = 1; page <= pageCount; page += 1) addScanCleanupDocumentCanvasPage(accumulator, {
            pageNumber: page,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 1224,
            heightPoints: 792,
            rotation: 0,
        }, planned.options, planned.layoutByPage?.[String(page)]);
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
