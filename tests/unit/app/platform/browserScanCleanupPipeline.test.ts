import {beforeEach, describe, expect, it, vi} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createRequestId} from '@contracts/shared';
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

        const makeAnalyzeResult = (sourcePageIndex: number): IScanCleanupWasmAnalyzeResult =>
            cast<IScanCleanupWasmAnalyzeResult>({
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
            pages: [{sourcePageIndex: 0, options: {}} as WasmAnalysisPageV3, {sourcePageIndex: 1, options: {}} as WasmAnalysisPageV3],
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

        mocks.runBrowserPageOpsWorkerRequest.mockImplementation(
            async (type: string, _payload: unknown, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('page-ops-sha');
                if (type === 'renderScanCleanupRaster') {
                    const header = new TextEncoder().encode('P6\n10 10\n255\n');
                    const ppm = new Uint8Array(header.byteLength + 10 * 10 * 3);
                    ppm.set(header);
                    return {
                        data: ppm,
                        report: {width: 10, height: 10},
                    };
                }
                if (type === 'ocrTextVisibility') {
                    return {pages: []};
                }
                return {status: 'failed', error: {code: 'unsupported', message: 'unused'}};
            },
        );

        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(
            async (_type: string, payload: {page: {sourcePageIndex: number}}, _signal: AbortSignal, onIdentity?: (sha: string) => void) => {
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
                        outputs: [
                            {
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
                                planes: [
                                    {
                                        role: 'composite',
                                        encoding: 'png',
                                        width: 10,
                                        height: 10,
                                        data: new Uint8Array([pageNumber]),
                                    },
                                ],
                            },
                        ],
                    },
                };
            },
        );

        mocks.runBrowserPdfCombineWorkerRequest.mockImplementation(
            async (
                _type: string,
                payload: {inputs: Array<{fileName: string}>},
                _signal: AbortSignal,
                opts?: {onEngineIdentity?: (sha: string) => void},
            ) => {
                opts?.onEngineIdentity?.('combine-sha');
                const name = payload.inputs[0]!.fileName;
                combineStarted.push(name);
                return name.startsWith('p1-') ? page1CombineGate.promise : page2CombineGate.promise;
            },
        );

        mocks.createOrderedPdfMerge.mockReturnValue({
            append: (bytes: Uint8Array) => appended.push(bytes),
            merge: async () => {
                stageAtMerge = progressEvents.at(-1)?.stage;
                return new Uint8Array([9, 9]);
            },
        });
        mocks.overlayPdfTextLayers.mockImplementation(
            async (assembled: Uint8Array, _source: Uint8Array, _req: unknown, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('page-ops-sha');
                return {
                    data: assembled,
                    report: {
                        accessibilityTagsRemoved: false,
                        textOmittedSourcePages: [],
                    },
                };
            },
        );
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
            onProgress: (progress) => progressEvents.push(progress),
        });

        // Both pages enter combinePdfs concurrently before either finishes.
        await vi.waitFor(() => expect(combineStarted).toHaveLength(2));
        expect(progressEvents.some((event) => event.stage === 'rendering' && (event.rasterizedUnits ?? 0) === 2)).toBe(true);

        // Page 2 finishes combinePdfs first and reports out-of-order progress immediately.
        page2CombineGate.resolve({data: new Uint8Array([22])});
        await vi.waitFor(() =>
            expect(
                progressEvents.some(
                    (event) => event.stage === 'rendering' && event.completedUnits === 1 && event.completedPageNumbers?.includes(2),
                ),
            ).toBe(true),
        );

        page1CombineGate.resolve({data: new Uint8Array([11])});
        await conversion;

        // Pages still assemble into the output PDF in strict document order.
        expect(appended).toEqual([new Uint8Array([11]), new Uint8Array([22])]);
        // Assembling is emitted before output.merge() runs.
        expect(stageAtMerge).toBe('assembling');
    });

    it('defers readSource until assembly, transfers assembled/source buffers without redundant copies, and validates qpdf via Blob', async () => {
        const {runBrowserScanCleanupConversion} = await import('@app/platform/browser-api/runBrowserScanCleanupConversion');
        const sourceBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
        const expectedSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes)), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');
        const events: string[] = [];
        const readSource = vi.fn(async () => {
            events.push('readSource');
            return sourceBytes;
        });
        const assembledBytes = new Uint8Array([1, 2, 3, 4]);
        const overlaidBytes = new Uint8Array([5, 6, 7, 8, 9]);

        const sourceBlob = new Blob([sourceBytes]);
        const inspectedBlobs: unknown[] = [];

        mocks.runBrowserPageOpsWorkerRequest.mockImplementation(
            async (type: string, payload: {source?: unknown}, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('page-ops-sha');
                if (type === 'renderScanCleanupRaster') {
                    events.push('renderRaster');
                    const header = new TextEncoder().encode('P6\n10 10\n255\n');
                    const ppm = new Uint8Array(header.byteLength + 10 * 10 * 3);
                    ppm.set(header);
                    return {
                        data: ppm,
                        report: {width: 10, height: 10, compatibility: 'exact'},
                    };
                }
                if (type === 'ocrTextVisibility') {
                    events.push('ocrTextVisibility');
                    inspectedBlobs.push(payload.source);
                    return {pages: []};
                }
                return {status: 'failed', error: {code: 'unsupported', message: 'unused'}};
            },
        );
        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(
            async (_type: string, payload: {page: {sourcePageIndex: number}}, _signal: AbortSignal, onIdentity?: (sha: string) => void) => {
                onIdentity?.('scan-cleanup-sha');
                return {
                    status: 'ok',
                    result: {
                        pageMetadata: {
                            pageNumber: payload.page.sourcePageIndex + 1,
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
                        outputs: [
                            {
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
                                planes: [
                                    {
                                        role: 'composite',
                                        encoding: 'png',
                                        width: 10,
                                        height: 10,
                                        data: new Uint8Array([1]),
                                    },
                                ],
                            },
                        ],
                    },
                };
            },
        );
        mocks.runBrowserPdfCombineWorkerRequest.mockImplementation(
            async (_type: string, _payload: unknown, _signal: AbortSignal, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('combine-sha');
                events.push('combinePdfs');
                return {data: new Uint8Array([10, 11])};
            },
        );
        mocks.createOrderedPdfMerge.mockReturnValue({
            append: vi.fn(),
            merge: async () => {
                events.push('merge');
                return assembledBytes;
            },
        });
        mocks.overlayPdfTextLayers.mockImplementation(
            async (
                data: Uint8Array,
                sourceData: Uint8Array,
                instructions: {provenanceStampHex?: string},
                opts?: {onEngineIdentity?: (sha: string) => void; transferInput?: boolean},
            ) => {
                events.push('overlay');
                opts?.onEngineIdentity?.('page-ops-sha');
                expect(data).toBe(assembledBytes);
                expect(sourceData).toBe(sourceBytes);
                expect(opts?.transferInput).toBe(true);
                const stampJson = Buffer.from(instructions.provenanceStampHex ?? '', 'hex').toString('utf8');
                expect(stampJson).toContain(expectedSha256);
                return {
                    data: overlaidBytes,
                    report: {
                        accessibilityTagsRemoved: false,
                        textOmittedSourcePages: [],
                    },
                };
            },
        );
        mocks.runBrowserQpdfCommand.mockImplementation(async (_command: string, input: unknown) => {
            events.push('qpdfCheck');
            expect(input).toBeInstanceOf(Blob);
            expect(new Uint8Array(await (input as Blob).arrayBuffer())).toEqual(overlaidBytes);
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
                output: null,
            };
        });

        const result = await runBrowserScanCleanupConversion({
            request: {
                sourcePdfPath: '/source/deferred.pdf',
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
                ref: '/source/deferred.pdf',
                revision: 'rev-deferred',
                pageSizes: [{pageNumber: 1, xPoints: 0, yPoints: 0, widthPoints: 100, heightPoints: 100, rotation: 0}],
                rasterRows: [],
                pageOpsEngineSha256: 'page-ops-sha',
                incompleteRasterPages: new Set(),
                rasterFacts: reduceScanCleanupRasterRows([]),
                annotatedPages: new Set(),
                source: sourceBlob,
                pdf: {} as never,
            },
            readSource,
            signal: new AbortController().signal,
            onProgress: () => undefined,
        });

        expect(readSource).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'renderRaster',
            'renderRaster',
            'combinePdfs',
            'merge',
            'readSource',
            'overlay',
            'ocrTextVisibility',
            'qpdfCheck',
        ]);
        expect(inspectedBlobs).toEqual([sourceBlob]);
        expect(result.pdf).toBeInstanceOf(Blob);
        expect(new Uint8Array(await result.pdf.arrayBuffer())).toEqual(overlaidBytes);
    });

    it('defers readSource until assembly in lossless mode, transfers sourceBytes to splitPdfPages, and validates qpdf via Blob', async () => {
        const {runBrowserScanCleanupConversion} = await import('@app/platform/browser-api/runBrowserScanCleanupConversion');
        const sourceBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x4c]);
        const expectedSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes)), (byte) =>
            byte.toString(16).padStart(2, '0'),
        ).join('');
        const splitBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x6f, 0x75, 0x74]);
        const events: string[] = [];
        let planCalls = 0;
        const readSource = vi.fn(async () => {
            events.push('readSource');
            return sourceBytes;
        });

        mocks.runBrowserPageOpsWorkerRequest.mockImplementation(
            async (type: string, _payload: unknown, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('page-ops-sha');
                if (type === 'renderScanCleanupRaster') {
                    events.push('renderRaster');
                    const header = new TextEncoder().encode('P6\n10 10\n255\n');
                    const ppm = new Uint8Array(header.byteLength + 10 * 10 * 3);
                    ppm.set(header);
                    return {
                        data: ppm,
                        report: {width: 10, height: 10, compatibility: 'exact'},
                    };
                }
                return {status: 'failed', error: {code: 'unsupported', message: 'unused'}};
            },
        );
        const analyzedMetadata = {
            pageNumber: 1,
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
            outputs: [
                {
                    half: 'full',
                    pdfPlacement: {
                        cropRect: {x: 0, y: 0, width: 100, height: 100},
                        contentScaled: false,
                    },
                },
            ],
        };
        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(
            async (type: string, _payload: unknown, _signal: AbortSignal, onIdentity?: (sha: string) => void) => {
                onIdentity?.('scan-cleanup-sha');
                if (type === 'plan-analysis') {
                    planCalls += 1;
                    if (planCalls === 1) {
                        return {
                            status: 'ok',
                            result: {
                                kind: 'jobs',
                                jobs: [{index: 0, view: 'primary', rerun: false}],
                            },
                        };
                    }
                    return {
                        status: 'ok',
                        result: {
                            kind: 'finished',
                            pages: [{pageMetadata: analyzedMetadata, pageMetadataJson: JSON.stringify(analyzedMetadata)}],
                        },
                    };
                }
                events.push('analyzePage');
                return {
                    status: 'ok',
                    result: {
                        pageMetadata: analyzedMetadata,
                        pageMetadataJson: JSON.stringify(analyzedMetadata),
                        reconciliation: null,
                    },
                };
            },
        );
        mocks.splitPdfPages.mockImplementation(
            async (
                data: Uint8Array,
                instructions: {provenanceStampHex?: string},
                opts?: {onEngineIdentity?: (sha: string) => void; transferInput?: boolean},
            ) => {
                events.push('splitPages');
                opts?.onEngineIdentity?.('page-ops-sha');
                expect(data).toBe(sourceBytes);
                expect(opts?.transferInput).toBe(true);
                const stampJson = Buffer.from(instructions.provenanceStampHex ?? '', 'hex').toString('utf8');
                expect(stampJson).toContain(expectedSha256);
                return {
                    data: splitBytes,
                    pageCount: 1,
                    report: {accessibilityTagsRemoved: false, textOmittedSourcePages: []},
                };
            },
        );
        mocks.runBrowserQpdfCommand.mockImplementation(async (_command: string, input: unknown) => {
            events.push('qpdfCheck');
            expect(input).toBeInstanceOf(Blob);
            expect(new Uint8Array(await (input as Blob).arrayBuffer())).toEqual(splitBytes);
            return {exitCode: 0, stdout: '', stderr: '', output: null};
        });

        const result = await runBrowserScanCleanupConversion({
            request: {
                sourcePdfPath: '/source/lossless.pdf',
                outputPdfPath: '',
                options: {
                    preserveOriginalQuality: true,
                    layoutMode: 'auto',
                    outputMode: 'auto',
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
                ref: '/source/lossless.pdf',
                revision: 'rev-lossless',
                pageSizes: [{pageNumber: 1, xPoints: 0, yPoints: 0, widthPoints: 100, heightPoints: 100, rotation: 0}],
                rasterRows: [],
                pageOpsEngineSha256: 'page-ops-sha',
                incompleteRasterPages: new Set(),
                rasterFacts: reduceScanCleanupRasterRows([]),
                annotatedPages: new Set(),
                source: new Blob([sourceBytes]),
                pdf: {} as never,
            },
            readSource,
            signal: new AbortController().signal,
            onProgress: () => undefined,
        });

        expect(readSource).toHaveBeenCalledOnce();
        expect(events).toEqual(['renderRaster', 'analyzePage', 'readSource', 'splitPages', 'qpdfCheck']);
        expect(result.pdf).toBeInstanceOf(Blob);
        expect(new Uint8Array(await result.pdf.arrayBuffer())).toEqual(splitBytes);
    });

    it('preserves base.source.ppm across base preview and mixed detail fallback while avoiding redundant raster copies', async () => {
        const {renderBrowserScanCleanupWorkspacePreview} = await import('@app/platform/browser-api/browserScanCleanupJob');
        const renderedByDpi = new Map<number, Uint8Array>();
        mocks.runBrowserPageOpsWorkerRequest.mockImplementation(
            async (type: string, payload: {request?: {dpi?: number}}, opts?: {onEngineIdentity?: (sha: string) => void}) => {
                opts?.onEngineIdentity?.('page-ops-sha');
                if (type === 'renderScanCleanupRaster') {
                    const dpi = payload.request?.dpi ?? 150;
                    const header = new TextEncoder().encode('P6\n8 8\n255\n');
                    const ppm = new Uint8Array(header.byteLength + 8 * 8 * 3);
                    ppm.set(header);
                    ppm.fill(dpi & 0xff, header.byteLength);
                    renderedByDpi.set(dpi, ppm);
                    return {
                        data: ppm,
                        report: {width: 8, height: 8, compatibility: 'exact'},
                    };
                }
                return {status: 'failed', error: {code: 'unsupported', message: 'unused'}};
            },
        );
        const transferredInputs: Uint8Array[] = [];
        mocks.runBrowserScanCleanupWorkerRequest.mockImplementation(
            async (type: string, payload: {ppm?: Uint8Array; input?: Uint8Array; analysisPlane?: {raster?: Uint8Array}}) => {
                if (type === 'encode-png') {
                    transferredInputs.push(payload.ppm!);
                    return {png: new Uint8Array([0x89, 0x50, 0x4e, 0x47])};
                }
                if (type === 'render-preview') {
                    transferredInputs.push(payload.input!);
                    if (payload.analysisPlane?.raster) {
                        transferredInputs.push(payload.analysisPlane.raster);
                    }
                    const rect = {xPx: 0, yPx: 0, widthPx: 8, heightPx: 8};
                    const appliedMargins = {leftPx: 0, topPx: 0, rightPx: 0, bottomPx: 0};
                    return {
                        status: 'ok',
                        result: {
                            pageMetadataJson: JSON.stringify({
                                version: 3,
                                sourcePageIndex: 0,
                                layoutClassification: 'single-uncut-page',
                                layoutConfidence: 0.9,
                                cutterXPx: null,
                                rotationDegrees: 0,
                                canvasScope: 'page',
                                excluded: false,
                                blankOutputsSkipped: 0,
                                outputCount: 1,
                                outputs: [
                                    {
                                        half: 'full',
                                        sourceRegion: rect,
                                        contentBox: null,
                                        cropRect: rect,
                                        appliedMargins,
                                        inputWidthPx: 8,
                                        inputHeightPx: 8,
                                    },
                                ],
                                tier1Verdict: 'single-uncut-page',
                                reconciled: false,
                                clusterAgreement: 0,
                            }),
                            outputs: [
                                {
                                    metadataJson: JSON.stringify({
                                        version: 3,
                                        sourcePageIndex: 0,
                                        half: 'full',
                                        layoutClassification: 'single-uncut-page',
                                        layoutConfidence: 0.9,
                                        cutterXPx: null,
                                        sourceRegion: rect,
                                        contentBox: null,
                                        cropRect: rect,
                                        appliedMargins,
                                        outputWidthPx: 8,
                                        outputHeightPx: 8,
                                        canvasWidthPx: 8,
                                        canvasHeightPx: 8,
                                        foldClipLeftPx: 0,
                                        foldClipRightPx: 0,
                                        inputWidthPx: 8,
                                        inputHeightPx: 8,
                                        skewApplied: false,
                                        placementOffsetXPx: 0,
                                        placementOffsetYPx: 0,
                                        forwardTransform: null,
                                        inverseTransform: null,
                                        dewarpModel: null,
                                        dewarpMapping: null,
                                        rotationDegrees: 0,
                                        canvasScope: 'page',
                                        resamplePasses: 0,
                                        warnings: [],
                                        warningEvents: [],
                                        outputMode: 'mixed',
                                        renderDpi: 150,
                                        bilevelWritten: false,
                                        layeredWritten: false,
                                    }),
                                    plane: {
                                        role: 'composite',
                                        encoding: 'png',
                                        width: 8,
                                        height: 8,
                                        data: new Uint8Array([1, 2, 3]),
                                    },
                                },
                            ],
                        },
                    };
                }
                throw new Error(`Unexpected scan cleanup worker request: ${type}`);
            },
        );

        const source = cast<import('@app/platform/browser-api/browserScanCleanupJob').IBrowserScanCleanupSource>({
            ref: 'browser://documents/preview-ownership.pdf',
            revision: 'drt1:browser:preview-ownership:1',
            pageSizes: [{pageNumber: 1, xPoints: 0, yPoints: 0, widthPoints: 612, heightPoints: 792, rotation: 0, renderBox: 'cropbox'}],
            rasterRows: [],
            incompleteRasterPages: new Set(),
            pageOpsEngineSha256: 'page-ops-sha',
            rasterFacts: reduceScanCleanupRasterRows([]),
            annotatedPages: new Set(),
            source: new Blob([Uint8Array.of(0x25, 0x50, 0x44, 0x46)]),
            pdf: {},
        });
        const baseOptions = {
            preserveOriginalQuality: false,
            layoutMode: 'auto' as const,
            outputMode: 'mixed' as const,
            readingOrder: 'ltr' as const,
            thickness: 0,
            crop: true,
            matchPageSize: false,
            pageAlignment: 'top-center' as const,
            marginsMm: {leftMm: 5, topMm: 5, rightMm: 5, bottomMm: 5},
            despeckle: true,
            skipBlankPages: false,
            pageOverrides: {},
        };

        const basePreview = await renderBrowserScanCleanupWorkspacePreview({
            request: {
                ownerId: 'owner-1',
                sourcePdfPath: source.ref,
                documentRevision: source.revision,
                requestId: createRequestId('req-base'),
                pageNumber: requirePageNumber(1),
                options: baseOptions,
            },
            source,
            signal: new AbortController().signal,
            base: null,
            emitRaw: () => undefined,
        });
        expect(basePreview.base).not.toBeNull();
        // Base preview keeps base.source.ppm unshared with the worker transfer payload.
        expect(transferredInputs).not.toContain(basePreview.base!.source.ppm);

        // Detail fallback (mixed mode) renders a fresh high-DPI raster and transfers it directly
        // without copying, while keeping base.source.ppm untouched.
        transferredInputs.length = 0;
        renderedByDpi.clear();
        await renderBrowserScanCleanupWorkspacePreview({
            request: {
                ownerId: 'owner-1',
                sourcePdfPath: source.ref,
                documentRevision: source.revision,
                requestId: createRequestId('req-detail'),
                pageNumber: requirePageNumber(1),
                options: baseOptions,
                detail: {
                    outputMode: 'mixed',
                    viewports: {
                        full: {
                            xNormalized: 0.25,
                            yNormalized: 0.25,
                            widthNormalized: 0.25,
                            heightNormalized: 0.25,
                            rotationDegrees: 0,
                        },
                    },
                },
            },
            source,
            signal: new AbortController().signal,
            base: basePreview.base,
            emitRaw: () => undefined,
        });
        expect(transferredInputs).not.toContain(basePreview.base!.source.ppm);
        expect(basePreview.base!.source.ppm.byteLength).toBeGreaterThan(0);
        // Fresh high-DPI detail raster was transferred directly without cloning.
        const detailRaster = [...renderedByDpi.entries()].find(([dpi]) => dpi > 150)?.[1];
        expect(detailRaster).toBeDefined();
        expect(transferredInputs).toContain(detailRaster);
    });

    it('accepts worker P6 PPM rasters zero-copy on the main thread and rejects mismatched payloads', async () => {
        const {renderPageRaster} = await import('@app/platform/browser-api/browserScanCleanupJob');
        const header = new TextEncoder().encode('P6\n4 3\n255\n');
        const workerPpm = new Uint8Array(header.byteLength + 4 * 3 * 3);
        workerPpm.set(header);
        workerPpm.fill(0x7a, header.byteLength);

        mocks.runBrowserPageOpsWorkerRequest.mockResolvedValueOnce({
            data: workerPpm,
            report: {width: 4, height: 3, compatibility: 'exact'},
        });

        const raster = await renderPageRaster(
            cast({
                ref: 'browser://documents/zero-copy-p6.pdf',
                revision: 'drt1:browser:zero-copy-p6:1',
                source: new Blob([Uint8Array.of(1, 2, 3)]),
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

        expect(raster.ppm).toBe(workerPpm);
        expect(raster.ppm.buffer).toBe(workerPpm.buffer);

        const corruptHeader = workerPpm.slice();
        corruptHeader[1] = 0x35; // P5 instead of P6
        mocks.runBrowserPageOpsWorkerRequest.mockResolvedValueOnce({
            data: corruptHeader,
            report: {width: 4, height: 3, compatibility: 'exact'},
        });
        await expect(
            renderPageRaster(
                cast({
                    ref: 'browser://documents/zero-copy-p6.pdf',
                    revision: 'drt1:browser:zero-copy-p6:1',
                    source: new Blob([Uint8Array.of(1, 2, 3)]),
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
            ),
        ).rejects.toThrow('Scan cleanup page raster does not match its size');
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
        const key1 = buildScanCleanupRasterCacheKey({
            ref: 'browser://doc/1',
            revision: 'rev-1',
            pageSize: makeRasterCachePageSize({pageNumber: 1}),
            dpi: 150,
        });
        const key2 = buildScanCleanupRasterCacheKey({
            ref: 'browser://doc/1',
            revision: 'rev-1',
            pageSize: makeRasterCachePageSize({pageNumber: 2}),
            dpi: 150,
        });
        const key3 = buildScanCleanupRasterCacheKey({
            ref: 'browser://doc/1',
            revision: 'rev-1',
            pageSize: makeRasterCachePageSize({pageNumber: 3}),
            dpi: 150,
        });

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
        const rotatedKey = buildScanCleanupRasterCacheKey({
            ref: 'browser://doc/1',
            revision: 'rev-1',
            pageSize: makeRasterCachePageSize({pageNumber: 1, rotation: 90}),
            dpi: 150,
        });
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

        const retryHeader = new TextEncoder().encode('P6\n4 4\n255\n');
        const retryPpm = new Uint8Array(retryHeader.byteLength + 4 * 4 * 3);
        retryPpm.set(retryHeader);
        retryPpm.fill(128, retryHeader.byteLength);
        mocks.runBrowserPageOpsWorkerRequest.mockRejectedValueOnce(notReadable).mockResolvedValueOnce({
            data: retryPpm,
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

        const readableRevisionSpy = vi
            .spyOn(browserDocumentStore, 'readableRevision')
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
            pages: [
                {
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
                },
            ],
        });
        const pdfMod = await import('@app/platform/browser-api/loadBrowserPdfjsDocument');
        vi.spyOn(pdfMod, 'loadBrowserPdfjsDocument').mockResolvedValue(
            cast({
                loadingTask: {destroy: vi.fn(async () => undefined)},
            }),
        );

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
