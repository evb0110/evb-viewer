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
