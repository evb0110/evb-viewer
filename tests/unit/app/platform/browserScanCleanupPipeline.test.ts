import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupWasmAnalyzeResult} from '@contracts/scan-cleanup/browserScanCleanupWasm';
import type {TScanCleanupProgress} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {WasmAnalysisPageV3} from '@contracts/scan-cleanup/nativeWire.generated';
import {reduceScanCleanupRasterRows} from '@evb/scan-cleanup/core/sourceRasterFacts';
import type {IPdfPageSize} from '@evb/scan-cleanup/core/types';
import {
    buildScanCleanupRasterCacheKey,
    createBrowserScanCleanupRasterCache,
    isCacheableScanCleanupRaster,
    scanCleanupRasterCacheBudgetBytes,
} from '@app/platform/browser-api/browserScanCleanupRasterCache';
import {cast} from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    runBrowserScanCleanupWorkerRequest: vi.fn(),
    runBrowserPdfCombineWorkerRequest: vi.fn(),
    runBrowserPageOpsWorkerRequest: vi.fn(),
    runBrowserQpdfCommand: vi.fn(),
    createOrderedPdfMerge: vi.fn(),
    overlayPdfTextLayers: vi.fn(),
    splitPdfPages: vi.fn(),
    resolveBrowserPageLanes: vi.fn(() => ({
        producerConcurrency: 2,
        maxChunkPages: 2,
        maxInFlightPages: 4,
        maxInFlightBytes: 256 * 1024 * 1024,
    })),
}));

vi.mock('@app/platform/browser-api/browserScanCleanupWorkerClient', () => ({
    estimateBrowserScanCleanupEngineBytes: () => 1024,
    resetDrainingBrowserScanCleanupWorkers: vi.fn(),
    runBrowserScanCleanupWorkerRequest: mocks.runBrowserScanCleanupWorkerRequest,
}));

vi.mock('@app/platform/browser-api/browserWorkerClient', () => ({
    resolveBrowserPageLanes: mocks.resolveBrowserPageLanes,
}));

vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({
    runBrowserPdfCombineWorkerRequest: mocks.runBrowserPdfCombineWorkerRequest,
}));

vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({
    BrowserPageOpsWorkerUnavailableError: class BrowserPageOpsWorkerUnavailableError extends Error {},
    evictBrowserPageOpsDocumentCache: vi.fn(),
    runBrowserPageOpsWorkerRequest: mocks.runBrowserPageOpsWorkerRequest,
}));

vi.mock('@app/platform/browser-api/browserPageOpsCore', () => ({
    createOrderedPdfMerge: mocks.createOrderedPdfMerge,
    overlayPdfTextLayers: mocks.overlayPdfTextLayers,
    splitPdfPages: mocks.splitPdfPages,
}));

vi.mock('@app/platform/browser-api/browserQpdfEngineClient', () => ({
    runBrowserQpdfCommand: mocks.runBrowserQpdfCommand,
}));

describe('browser scan cleanup runtime scheduling & progress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('emits onAnalyzed out-of-order as soon as page 2 finishes while page 1 is still analyzing', async () => {
        const {runBrowserScanCleanupAnalysis} = await import('@app/platform/browser-api/browserScanCleanupJob');
        const page1Gate = Promise.withResolvers<IScanCleanupWasmAnalyzeResult>();
        const page2Gate = Promise.withResolvers<IScanCleanupWasmAnalyzeResult>();
        let planCalls = 0;

        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(async (type: string, payload: {page?: {sourcePageIndex?: number}}) => {
            if (type === 'plan-analysis') {
                planCalls += 1;
                if (planCalls === 1) {
                    return {
                        status: 'ok',
                        result: {
                            kind: 'jobs',
                            jobs: [
                                {index: 0, view: 'primary', rerun: false},
                                {index: 1, view: 'primary', rerun: false},
                            ],
                        },
                    };
                }
                return {
                    status: 'ok',
                    result: {
                        kind: 'finished',
                        pages: [],
                    },
                };
            }
            const result = payload.page?.sourcePageIndex === 0 ? await page1Gate.promise : await page2Gate.promise;
            return {status: 'ok', result};
        });

        const makeAnalyzeResult = (sourcePageIndex: number): IScanCleanupWasmAnalyzeResult => cast<IScanCleanupWasmAnalyzeResult>({
            pageMetadata: {
                pageNumber: sourcePageIndex + 1,
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0,
            },
            pageMetadataJson: JSON.stringify({sourcePageIndex}),
            reconciliation: null,
        });

        const analyzedIndices: number[] = [];
        const completedRecords: Array<{
            index: number;
            pageMetadataJson: string;
        }> = [];
        const firstCallbackGate = Promise.withResolvers<void>();
        let activeCallbacks = 0;
        let maxConcurrentCallbacks = 0;
        const analysis = runBrowserScanCleanupAnalysis({
            pages: [
                {sourcePageIndex: 0, options: {}} as WasmAnalysisPageV3,
                {sourcePageIndex: 1, options: {}} as WasmAnalysisPageV3,
            ],
            canvasScope: 'page',
            renderMode: 'preview',
            signal: new AbortController().signal,
            estimatePixels: () => 100,
            rasterize: async () => new Uint8Array([1, 2, 3]),
            onAnalyzed: async (job, result) => {
                activeCallbacks += 1;
                maxConcurrentCallbacks = Math.max(maxConcurrentCallbacks, activeCallbacks);
                try {
                    analyzedIndices.push(job.index);
                    if (job.index === 1) {
                        await firstCallbackGate.promise;
                    }
                    completedRecords.push({
                        index: job.index,
                        pageMetadataJson: result.pageMetadataJson,
                    });
                } finally {
                    activeCallbacks -= 1;
                }
            },
        });

        page2Gate.resolve(makeAnalyzeResult(1));
        await vi.waitFor(() => expect(analyzedIndices).toEqual([1]));

        // Page 1 completes while page 2's async onAnalyzed is still in flight;
        // notifications must serialize without overlapping.
        page1Gate.resolve(makeAnalyzeResult(0));
        await Promise.resolve();
        await Promise.resolve();
        expect(analyzedIndices).toEqual([1]);

        firstCallbackGate.resolve();
        await analysis;
        expect(analyzedIndices).toEqual([1, 0]);
        expect(maxConcurrentCallbacks).toBe(1);
        expect(completedRecords).toEqual([
            {
                index: 1,
                pageMetadataJson: '{"sourcePageIndex":1}',
            },
            {
                index: 0,
                pageMetadataJson: '{"sourcePageIndex":0}',
            },
        ]);
    });

    it('runs per-page combinePdfs in parallel during produce, emits out-of-order progress and rasterizedUnits, and emits assembling before merge', async () => {
        const {runBrowserScanCleanupConversion} = await import('@app/platform/browser-api/runBrowserScanCleanupConversion');
        const combineStarted: string[] = [];
        const page1CombineGate = Promise.withResolvers<{data: Uint8Array}>();
        const page2CombineGate = Promise.withResolvers<{data: Uint8Array}>();
        const appended: Uint8Array[] = [];
        const progressEvents: TScanCleanupProgress[] = [];
        let stageAtMerge: TScanCleanupProgress['stage'] | undefined;

        mocks.runBrowserPageOpsWorkerRequest.mockImplementation(async (type: string, _payload: unknown, opts?: {onEngineIdentity?: (sha: string) => void}) => {
            opts?.onEngineIdentity?.('page-ops-sha');
            if (type === 'renderScanCleanupRaster') {
                return {
                    data: new Uint8Array(10 * 10 * 3),
                    report: {width: 10, height: 10},
                };
            }
            if (type === 'ocrTextVisibility') {
                return {pages: []};
            }
            return {status: 'failed', error: {code: 'unsupported', message: 'unused'}};
        });

        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(async (_type: string, payload: {page: {sourcePageIndex: number}}, _signal: AbortSignal, onIdentity?: (sha: string) => void) => {
            onIdentity?.('scan-cleanup-sha');
            const pageNumber = payload.page.sourcePageIndex + 1;
            return {
                status: 'ok',
                result: {
                    pageMetadata: {
                        pageNumber,
                        canvasScope: 'document',
                        layoutClassification: 'single-uncut-page',
                        layoutConfidence: 0.95,
                        cutterXPx: null,
                        rotationDegrees: 0,
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 1,
                        tier1Verdict: 'single-uncut-page',
                        reconciled: false,
                        clusterAgreement: 0,
                    },
                    outputs: [{
                        metadata: {
                            half: 'full',
                            outputMode: 'bw',
                            rotationDegrees: 0,
                            skewApplied: false,
                            skewDegrees: 0,
                            canvasWidthPx: 10,
                            canvasHeightPx: 10,
                            renderDpi: 150,
                            bilevelWritten: false,
                            layeredWritten: false,
                            contentBox: {x: 0, y: 0, width: 10, height: 10},
                        },
                        planes: [{
                            role: 'composite',
                            encoding: 'png',
                            width: 10,
                            height: 10,
                            data: new Uint8Array([pageNumber]),
                        }],
                    }],
                },
            };
        });

        mocks.runBrowserPdfCombineWorkerRequest.mockImplementation(async (_type: string, payload: {inputs: Array<{fileName: string}>}, _signal: AbortSignal, opts?: {onEngineIdentity?: (sha: string) => void}) => {
            opts?.onEngineIdentity?.('combine-sha');
            const name = payload.inputs[0]!.fileName;
            combineStarted.push(name);
            return name.startsWith('p1-') ? page1CombineGate.promise : page2CombineGate.promise;
        });

        mocks.createOrderedPdfMerge.mockReturnValue({
            append: (bytes: Uint8Array) => appended.push(bytes),
            merge: async () => {
                stageAtMerge = progressEvents.at(-1)?.stage;
                return new Uint8Array([9, 9]);
            },
        });
        mocks.overlayPdfTextLayers.mockImplementation(async (assembled: Uint8Array, _source: Uint8Array, _req: unknown, opts?: {onEngineIdentity?: (sha: string) => void}) => {
            opts?.onEngineIdentity?.('page-ops-sha');
            return {
                data: assembled,
                report: {
                    accessibilityTagsRemoved: false,
                    textOmittedSourcePages: [],
                },
            };
        });
        mocks.runBrowserQpdfCommand.mockResolvedValue({
            exitCode: 0,
            stdout: '',
            stderr: '',
            output: null,
        });

        const conversion = runBrowserScanCleanupConversion({
            request: {
                sourcePdfPath: '/source/two-pages.pdf',
                outputPdfPath: '',
                options: {
                    preserveOriginalQuality: false,
                    layoutMode: 'auto',
                    outputMode: 'bw',
                    readingOrder: 'ltr',
                    thickness: 0,
                    crop: true,
                    matchPageSize: false,
                    pageAlignment: 'top-center',
                    marginsMm: {leftMm: 5, topMm: 5, rightMm: 5, bottomMm: 5},
                    despeckle: true,
                    skipBlankPages: false,
                    pageOverrides: {},
                },
            },
            source: {
                ref: '/source/two-pages.pdf',
                revision: 'rev-1',
                pageSizes: [
                    {pageNumber: 1, xPoints: 0, yPoints: 0, widthPoints: 100, heightPoints: 100, rotation: 0},
                    {pageNumber: 2, xPoints: 0, yPoints: 0, widthPoints: 100, heightPoints: 100, rotation: 0},
                ],
                rasterRows: [],
                pageOpsEngineSha256: 'page-ops-sha',
                incompleteRasterPages: new Set(),
                rasterFacts: reduceScanCleanupRasterRows([]),
                annotatedPages: new Set(),
                data: new Uint8Array([37, 80, 68, 70]),
                pdf: {} as never,
            },
            readSource: async () => new Uint8Array([37, 80, 68, 70]),
            signal: new AbortController().signal,
            onProgress: progress => progressEvents.push(progress),
        });

        // Both pages enter combinePdfs concurrently before either finishes.
        await vi.waitFor(() => expect(combineStarted).toHaveLength(2));
        expect(progressEvents.some(event => event.stage === 'rendering' && (event.rasterizedUnits ?? 0) === 2)).toBe(true);

        // Page 2 finishes combinePdfs first and reports out-of-order progress immediately.
        page2CombineGate.resolve({data: new Uint8Array([22])});
        await vi.waitFor(() => expect(progressEvents.some(
            event => event.stage === 'rendering' && event.completedUnits === 1 && event.completedPageNumbers?.includes(2),
        )).toBe(true));

        page1CombineGate.resolve({data: new Uint8Array([11])});
        await conversion;

        // Pages still assemble into the output PDF in strict document order.
        expect(appended).toEqual([new Uint8Array([11]), new Uint8Array([22])]);
        // Assembling is emitted before output.merge() runs.
        expect(stageAtMerge).toBe('assembling');
    });
});

function makeRasterCachePageSize(overrides: Partial<IPdfPageSize> = {}): IPdfPageSize {
    return {
        pageNumber: 1,
        renderBox: 'cropbox',
        rotation: 0,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        userUnit: 1,
        ...overrides,
    };
}

function makeCachedRaster(fill: number, byteLength = 64, dpi = 150) {
    const ppm = new Uint8Array(byteLength);
    ppm.fill(fill);
    return {
        ppm,
        width: 10,
        height: 10,
        dpi,
    };
}

describe('browserScanCleanupRasterCache', () => {
    it('sizes the byte budget from deviceMemory (64 MiB <=4 GiB, 128 MiB >4 GiB)', () => {
        expect(scanCleanupRasterCacheBudgetBytes(2)).toBe(64 * 1024 * 1024);
        expect(scanCleanupRasterCacheBudgetBytes(4)).toBe(64 * 1024 * 1024);
        expect(scanCleanupRasterCacheBudgetBytes(undefined)).toBe(64 * 1024 * 1024);
        expect(scanCleanupRasterCacheBudgetBytes(8)).toBe(128 * 1024 * 1024);
    });

    it('caches full-page rasters at <=150 DPI and skips cropped regions or high-DPI conversion renders', () => {
        expect(isCacheableScanCleanupRaster(150, undefined)).toBe(true);
        expect(isCacheableScanCleanupRaster(72, undefined)).toBe(true);
        expect(isCacheableScanCleanupRaster(300, undefined)).toBe(false);
        expect(isCacheableScanCleanupRaster(150, {x: 0, y: 0, width: 100, height: 100})).toBe(false);
    });

    it('clones buffers on put and get, replays pageOpsEngineSha256, and evicts in LRU order', () => {
        const cache = createBrowserScanCleanupRasterCache(128);
        const key1 = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-1', pageSize: makeRasterCachePageSize({pageNumber: 1}), dpi: 150});
        const key2 = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-1', pageSize: makeRasterCachePageSize({pageNumber: 2}), dpi: 150});
        const key3 = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-1', pageSize: makeRasterCachePageSize({pageNumber: 3}), dpi: 150});

        const input1 = makeCachedRaster(11, 64);
        cache.set(key1, input1, 'sha-pageops-1');
        input1.ppm.fill(0);

        cache.set(key2, makeCachedRaster(22, 64), 'sha-pageops-1');
        expect(cache.stats()).toMatchObject({entries: 2, bytes: 128});

        const hit1 = cache.get(key1);
        expect(hit1?.pageOpsEngineSha256).toBe('sha-pageops-1');
        expect(hit1?.raster.ppm[0]).toBe(11);
        hit1?.raster.ppm.fill(99);
        expect(cache.get(key1)?.raster.ppm[0]).toBe(11);

        cache.set(key3, makeCachedRaster(33, 64), 'sha-pageops-2');
        expect(cache.get(key2)).toBeNull();
        expect(cache.get(key1)?.raster.ppm[0]).toBe(11);
        expect(cache.get(key3)?.raster.ppm[0]).toBe(33);
        expect(cache.stats()).toMatchObject({entries: 2, bytes: 128});
    });

    it('invalidates cleanly on revision, rotation, DPI, or document ref changes', () => {
        const cache = createBrowserScanCleanupRasterCache(1024);
        const base = makeRasterCachePageSize({pageNumber: 1, rotation: 0});
        const rev1Key = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-1', pageSize: base, dpi: 150});
        const rev2Key = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-2', pageSize: base, dpi: 150});
        const rotatedKey = buildScanCleanupRasterCacheKey({ref: 'browser://doc/1', revision: 'rev-1', pageSize: makeRasterCachePageSize({pageNumber: 1, rotation: 90}), dpi: 150});
        const otherDocKey = buildScanCleanupRasterCacheKey({ref: 'browser://doc/2', revision: 'rev-1', pageSize: base, dpi: 150});

        cache.set(rev1Key, makeCachedRaster(1, 32), null);
        cache.set(rev2Key, makeCachedRaster(2, 32), null);
        cache.set(rotatedKey, makeCachedRaster(3, 32), null);
        cache.set(otherDocKey, makeCachedRaster(4, 32), null);

        expect(rev1Key).not.toBe(rotatedKey);
        expect(rev1Key).not.toBe(rev2Key);

        cache.invalidateByRevision('browser://doc/1', 'rev-1');
        expect(cache.get(rev1Key)).toBeNull();
        expect(cache.get(rotatedKey)).toBeNull();
        expect(cache.get(rev2Key)?.raster.ppm[0]).toBe(2);
        expect(cache.get(otherDocKey)?.raster.ppm[0]).toBe(4);

        cache.invalidateByRef('browser://doc/1');
        expect(cache.get(rev2Key)).toBeNull();
        expect(cache.get(otherDocKey)?.raster.ppm[0]).toBe(4);
    });
});

describe('stale OPFS Blob refresh on NotReadableError', () => {
    it('retries renderPageRaster once using refreshSource when worker returns NotReadableError without name in message', async () => {
        const {renderPageRaster} = await import('@app/platform/browser-api/browserScanCleanupJob');
        const staleBlob = new Blob([Uint8Array.of(1, 2, 3)]);
        const freshBlob = new Blob([Uint8Array.of(4, 5, 6)]);
        const refreshSource = vi.fn(async () => freshBlob);
        const notReadable = new Error('The requested file could not be read.');
        notReadable.name = 'NotReadableError';

        mocks.runBrowserPageOpsWorkerRequest
            .mockRejectedValueOnce(notReadable)
            .mockResolvedValueOnce({
                data: new Uint8Array(4 * 4 * 3).fill(128),
                report: {width: 4, height: 4, compatibility: 'exact'},
            });

        const raster = await renderPageRaster(
            cast({
                ref: 'browser://documents/stale-refresh.pdf',
                revision: 'drt1:browser:stale-refresh:1',
                source: staleBlob,
                refreshSource,
                pageSizes: [],
                rasterRows: [],
                incompleteRasterPages: new Set(),
                pageOpsEngineSha256: null,
                rasterFacts: reduceScanCleanupRasterRows([]),
                annotatedPages: new Set(),
                pdf: {},
            }),
            makeRasterCachePageSize({pageNumber: 1}),
            300,
            4_000_000,
            new AbortController().signal,
        );

        expect(refreshSource).toHaveBeenCalledOnce();
        expect(mocks.runBrowserPageOpsWorkerRequest).toHaveBeenCalledTimes(2);
        expect(mocks.runBrowserPageOpsWorkerRequest.mock.calls[1]?.[1]).toMatchObject({source: freshBlob});
        expect(raster.width).toBe(4);
        expect(raster.height).toBe(4);
    });

    it('binds openSource inspection and refreshSource strictly to the revision-pinned Blob through readableRevision(ref, {token})', async () => {
        const {browserDocumentStore} = await import('@app/platform/browserDocumentStore');
        const {requireDocumentRevisionToken} = await import('@contracts/documentRevision');
        const {borrowBrowserScanCleanupSource} = await import('@app/platform/browser-api/browserScanCleanupSources');
        const ref = 'browser://documents/refresh-bound.pdf';
        const token = requireDocumentRevisionToken('drt1:browser:refresh-bound:1');
        const instance = Symbol('entry');
        const pinnedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        const initialBlob = new Blob([pinnedBytes]);
        const refreshedBlob = new Blob([pinnedBytes]);

        const readableRevisionSpy = vi.spyOn(browserDocumentStore, 'readableRevision')
            .mockResolvedValueOnce({
                blob: initialBlob,
                token,
                byteRevision: 1,
                instance,
            })
            .mockResolvedValueOnce({
                blob: refreshedBlob,
                token,
                byteRevision: 1,
                instance,
            });
        vi.spyOn(browserDocumentStore, 'assertDocumentRevisionCurrent').mockResolvedValue(undefined);
        const readSpy = vi.spyOn(browserDocumentStore, 'read');
        mocks.runBrowserPageOpsWorkerRequest.mockResolvedValueOnce({
            pageCount: 1,
            pages: [{
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                userUnit: 1,
                rasterUses: [],
                rasterInventoryComplete: true,
                hasAnnotations: false,
            }],
        });
        const pdfMod = await import('@app/platform/browser-api/loadBrowserPdfjsDocument');
        vi.spyOn(pdfMod, 'loadBrowserPdfjsDocument').mockResolvedValue(cast({
            loadingTask: {destroy: vi.fn(async () => undefined)},
        }));

        const borrow = borrowBrowserScanCleanupSource(ref, token);
        try {
            const source = await borrow.opened;
            // Inspection reads directly from the revision-pinned Blob instead of a separate store.read(ref).
            expect(readSpy).not.toHaveBeenCalled();
            expect(mocks.runBrowserPageOpsWorkerRequest.mock.calls[0]?.[1]).toMatchObject({data: pinnedBytes});
            readableRevisionSpy.mockClear();
            const refreshed = await source.refreshSource!();
            expect(readableRevisionSpy).toHaveBeenCalledWith(ref, {token});
            expect(refreshed).toBe(refreshedBlob);
            expect(source.source).toBe(refreshedBlob);
        } finally {
            borrow.release();
            vi.restoreAllMocks();
        }
    });
});
