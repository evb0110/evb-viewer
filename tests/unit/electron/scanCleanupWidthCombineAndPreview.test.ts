import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import type {IScanCleanupOptions} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requireRequestId} from '@contracts/shared';
import {
    JobBroker,
    MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
    MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
    resolveMainJobBrokerCapacity,
    type IJobBrokerLease,
    type IJobBrokerRunContext,
} from '@electron/resources/jobBroker';
import {resolvePdfImageCombineThreads} from '@electron/native-tools/pdfImageCombineBudget';
import {
    createScanCleanupPreviewBrokerRequest,
    resolveScanCleanupPreviewRasterAdmissionPolicy,
    resolveScanCleanupPreviewRasterSlotResidentBytes,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {getUnprovenNativeTerminationDetail, markUnprovenNativeTermination} from '@contracts/nativeErrors';
import {runBoundedRasterProducerConsumer} from '@evb/scan-cleanup/core/streamingRasterHandoff';
import {resolveScanCleanupSidecarMaxThreads} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    resolveScanCleanupCombineLeaseResources,
    runScanCleanupPipeline,
    runWithScanCleanupConversionPhaseBroker,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {partitionScanCleanupCpuBudget} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {runScanCleanupConversion, type IRunScanCleanupPipelineDependencies} from '@evb/scan-cleanup/core/runScanCleanupConversion';
import {
    createScanCleanupPageRasterSource,
    createScanCleanupPreviewTestContext,
    PNG,
    ppmWithDimensions,
    previewOf,
    request as previewRequest,
    sender,
    SETTLED_SINGLE_LAYOUT_BY_PAGE,
} from '@tests/unit/electron/scanCleanupPreviewHarness';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs.splice(0).map((dir) =>
            rm(dir, {
                recursive: true,
                force: true,
            }),
        ),
    );
});

function createHostProfile(
    overrides: Partial<IHostResourceProfileSnapshot> & Pick<IHostResourceProfileSnapshot, 'logicalCpus' | 'totalRamBytes'>,
): IHostResourceProfileSnapshot {
    return {
        safeMode: false,
        detectedTier: overrides.totalRamBytes <= 8 * GIB ? 'low' : overrides.logicalCpus >= 12 ? 'high' : 'medium',
        performanceMode: 'auto',
        tier: overrides.totalRamBytes <= 8 * GIB ? 'low' : overrides.logicalCpus >= 12 ? 'high' : 'medium',
        ...overrides,
    };
}

const baseCleanupOptions: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
    readingOrder: 'ltr',
    thickness: 0,
    crop: false,
    matchPageSize: false,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: false,
    skipBlankPages: false,
    pageOverrides: {},
};

async function createConversionHarness(input: {
    pageCount: number;
    preserveOriginalQuality?: boolean;
    withOverlayText?: boolean;
    runWithCombineLease?: IRunScanCleanupPipelineDependencies['runWithCombineLease'];
}) {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-o3-o10-'));
    tempDirs.push(dir);
    const sourcePdfPath = join(dir, 'source.pdf');
    const outputPdfPath = join(dir, 'cleaned.pdf');
    await writeFile(sourcePdfPath, Buffer.from('%PDF-1.4\n%test\n%%EOF\n'));

    const pageSizes = Array.from({length: input.pageCount}, (_, index) => ({
        pageNumber: index + 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
    }));

    const qpdfChecks: string[] = [];
    const combineCalls: Array<{args: string[]; command: string}> = [];
    const sidecarMaxThreadsCalls: Array<number | undefined> = [];

    const runCommand: IRunScanCleanupPipelineDependencies['runCommand'] = vi.fn(async (command, args) => {
        if (command === '/qpdf' && args[0] === '--check') {
            qpdfChecks.push(args[1] ?? '');
            return {exitCode: 0, stdout: '', stderr: ''};
        }
        if (command === '/combine') {
            combineCalls.push({command, args: [...args]});
            const outputIndex = args.indexOf('--output');
            if (outputIndex >= 0 && args[outputIndex + 1]) {
                await writeFile(args[outputIndex + 1]!, Buffer.from('%PDF-1.4\n%combined\n%%EOF\n'));
            }
            return {exitCode: 0, stdout: '', stderr: ''};
        }
        if (command === '/page-ops') {
            const outputIndex = args.indexOf('--output');
            if (outputIndex >= 0 && args[outputIndex + 1]) {
                if (args[0] === 'annotation-index') {
                    await writeFile(
                        args[outputIndex + 1]!,
                        `${JSON.stringify({
                            format: 'evb-pdf-annotation-name-index',
                            schemaVersion: 1,
                            pageCount: input.pageCount,
                            chunkBytes: 65536,
                        })}\n`,
                    );
                } else {
                    await writeFile(args[outputIndex + 1]!, Buffer.from('%PDF-1.4\n%pageops\n%%EOF\n'));
                }
            }
            return {exitCode: 0, stdout: JSON.stringify({textOmittedSourcePages: [], accessibilityTagsRemoved: false}), stderr: ''};
        }
        return {exitCode: 0, stdout: '', stderr: ''};
    });

    const dependencies: IRunScanCleanupPipelineDependencies = {
        getPageCount: vi.fn(async () => input.pageCount),
        getPageSizeStore: vi.fn(async () => createArrayBackedPdfPageSizeStore(pageSizes)),
        detectSourceDpi: vi.fn(async () => ({
            detected: true,
            documentDpi: 300,
            getPageRaster: () => ({dpi: 300, width: 2550, height: 3300}),
        })),
        renderPage: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(outputPath, ppmWithDimensions(1, 1));
        }),
        runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, _onProgress, sidecarOptions) => {
            sidecarMaxThreadsCalls.push(sidecarOptions?.maxThreads);
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                operation: 'analyze' | 'render';
                pages: Array<{
                    sourcePageIndex: number;
                    pageMetadataPath: string;
                    outputs: Array<{outputPath: string; metadataPath: string}>;
                }>;
            };
            for (const page of manifest.pages) {
                if (manifest.operation === 'analyze') {
                    await writeFile(
                        page.pageMetadataPath,
                        JSON.stringify({
                            canvasScope: 'document',
                            layoutClassification: 'single-uncut-page',
                            detectedSkewDegrees: 0,
                            skewConfidence: 0,
                            cutterXPx: null,
                            rotationDegrees: 0,
                            excluded: false,
                            blankOutputsSkipped: 0,
                            outputCount: 1,
                            outputs: [
                                {
                                    half: 'full',
                                    sourceRegion: {xPx: 0, yPx: 0, widthPx: 100, heightPx: 100},
                                    cropRect: {xPx: 0, yPx: 0, widthPx: 100, heightPx: 100},
                                    contentBox: {xPx: 0, yPx: 0, widthPx: 100, heightPx: 100},
                                    inputWidthPx: 100,
                                    inputHeightPx: 100,
                                    pdfPlacement: {
                                        cropRect: {x: 0, y: 0, width: 612, height: 792},
                                        contentScaled: false,
                                    },
                                },
                            ],
                        }),
                    );
                    continue;
                }
                await writeFile(
                    page.pageMetadataPath,
                    JSON.stringify({
                        canvasScope: 'document',
                        layoutClassification: 'single-uncut-page',
                        detectedSkewDegrees: 0,
                        skewConfidence: 0,
                        cutterXPx: null,
                        rotationDegrees: 0,
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 1,
                    }),
                );
                const output = page.outputs[0]!;
                await writeFile(output.outputPath, PNG);
                await writeFile(
                    output.metadataPath,
                    JSON.stringify({
                        canvasScope: 'document',
                        half: 'full',
                        layoutClassification: 'single-uncut-page',
                        layoutConfidence: 0.95,
                        detectedSkewDegrees: 0,
                        skewConfidence: 0,
                        skewApplied: true,
                        sourceRegion: {xPx: 0, yPx: 0, widthPx: 1, heightPx: 1},
                        contentBox: {xPx: 0, yPx: 0, widthPx: 1, heightPx: 1},
                        appliedMargins: {leftPx: 0, topPx: 0, rightPx: 0, bottomPx: 0},
                        outputWidthPx: 1,
                        outputHeightPx: 1,
                        canvasWidthPx: 1,
                        canvasHeightPx: 1,
                        placementOffsetXPx: 0,
                        placementOffsetYPx: 0,
                        cutterXPx: null,
                        inputWidthPx: 1,
                        inputHeightPx: 1,
                        rotationDegrees: 0,
                        resamplePasses: 1,
                        outputMode: 'bw',
                        illuminationNormalized: false,
                        despeckleFallback: false,
                        warningEvents: [],
                        ...(input.withOverlayText
                            ? {
                                  forwardTransform: {
                                      matrix: [
                                          [1, 0, 0],
                                          [0, 1, 0],
                                          [0, 0, 1],
                                      ],
                                  },
                                  inverseTransform: {
                                      matrix: [
                                          [1, 0, 0],
                                          [0, 1, 0],
                                          [0, 0, 1],
                                      ],
                                  },
                              }
                            : {}),
                        warnings: [],
                    }),
                );
            }
        }),
        runCommand,
        getAvailableScratchBytes: vi.fn(async () => 16 * GIB),
        hashNativeBinary: vi.fn(async () => 'deadbeef'),
        ...(input.runWithCombineLease === undefined ? {} : {runWithCombineLease: input.runWithCombineLease}),
    };

    return {
        dir,
        sourcePdfPath,
        outputPdfPath,
        dependencies,
        qpdfChecks,
        combineCalls,
        sidecarMaxThreadsCalls,
        paths: {
            qpdfBinary: '/qpdf',
            pdftoppmBinary: '/pdftoppm',
            pdfimagesBinary: '/pdfimages',
            scanCleanupBinary: '/scan-cleanup',
            pdfImageCombineBinary: '/combine',
            pdfPageOpsBinary: '/page-ops',
            tempDir: dir,
        },
        options: {
            ...baseCleanupOptions,
            preserveOriginalQuality: input.preserveOriginalQuality === true,
        },
    };
}

describe('O-9: broker-admitted Scan Cleanup CPU partitioning and sidecar width', () => {
    it('partitions producers and sidecar threads within broker CPU budget across 2-core, 8-core/8GiB, low-mode, and 16-32-core hosts', () => {
        const twoCore = createHostProfile({logicalCpus: 2, totalRamBytes: 4 * GIB});
        const twoCoreCap = resolveMainJobBrokerCapacity(twoCore);
        const twoCorePolicy = resolveScanCleanupPreviewRasterAdmissionPolicy(twoCoreCap, baseCleanupOptions, twoCore.logicalCpus);
        expect(twoCorePolicy.rasterConcurrency).toBe(1);
        expect(twoCorePolicy.sidecarThreads).toBe(1);
        expect(twoCorePolicy.cpuTokens).toBe(1);
        expect(twoCorePolicy.nativeProcesses).toBe(1);
        expect(twoCorePolicy.ioWeight).toBe(3);
        expect(twoCorePolicy.serializeStages).toBe(true);

        const eightCore8Gib = createHostProfile({logicalCpus: 8, totalRamBytes: 8 * GIB});
        const eightCore8GibCap = resolveMainJobBrokerCapacity(eightCore8Gib);
        const eightCore8GibPolicy = resolveScanCleanupPreviewRasterAdmissionPolicy(
            eightCore8GibCap,
            baseCleanupOptions,
            eightCore8Gib.logicalCpus,
        );
        expect(eightCore8GibPolicy.rasterConcurrency).toBe(1);
        expect(eightCore8GibPolicy.sidecarThreads).toBe(5);
        expect(eightCore8GibPolicy.cpuTokens).toBe(5);
        expect(eightCore8GibPolicy.nativeProcesses).toBe(1);
        expect(eightCore8GibPolicy.ioWeight).toBe(3);
        expect(eightCore8GibPolicy.serializeStages).toBe(true);

        const sixteenCoreLowMode = createHostProfile({
            logicalCpus: 16,
            totalRamBytes: 32 * GIB,
            performanceMode: 'low',
            tier: 'low',
        });
        const lowModeCap = resolveMainJobBrokerCapacity(sixteenCoreLowMode);
        const lowModePolicy = resolveScanCleanupPreviewRasterAdmissionPolicy(
            lowModeCap,
            baseCleanupOptions,
            sixteenCoreLowMode.logicalCpus,
        );
        expect(lowModePolicy.rasterConcurrency).toBe(1);
        expect(lowModePolicy.sidecarThreads).toBe(1);
        expect(lowModePolicy.cpuTokens).toBe(1);
        expect(lowModePolicy.nativeProcesses).toBe(1);
        expect(lowModePolicy.ioWeight).toBe(3);
        expect(lowModePolicy.serializeStages).toBe(true);

        const sixteenCore = createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB});
        const sixteenCoreCap = resolveMainJobBrokerCapacity(sixteenCore);
        const sixteenCorePolicy = resolveScanCleanupPreviewRasterAdmissionPolicy(
            sixteenCoreCap,
            baseCleanupOptions,
            sixteenCore.logicalCpus,
        );
        expect(sixteenCorePolicy.rasterConcurrency).toBe(7);
        expect(sixteenCorePolicy.sidecarThreads).toBe(4);
        expect(sixteenCorePolicy.cpuTokens).toBe(11);
        expect(sixteenCorePolicy.nativeProcesses).toBe(7);
        expect(sixteenCorePolicy.ioWeight).toBe(4);
        expect(sixteenCorePolicy.serializeStages).toBe(false);
        expect(sixteenCorePolicy.rasterConcurrency + (sixteenCorePolicy.sidecarThreads ?? 0)).toBeLessThanOrEqual(
            sixteenCoreCap.cpuTokens - 1,
        );

        const thirtyTwoCore = createHostProfile({logicalCpus: 32, totalRamBytes: 64 * GIB});
        const thirtyTwoCoreCap = resolveMainJobBrokerCapacity(thirtyTwoCore);
        const thirtyTwoCorePolicy = resolveScanCleanupPreviewRasterAdmissionPolicy(
            thirtyTwoCoreCap,
            baseCleanupOptions,
            thirtyTwoCore.logicalCpus,
        );
        expect(thirtyTwoCorePolicy.rasterConcurrency).toBe(15);
        expect(thirtyTwoCorePolicy.sidecarThreads).toBe(8);
        expect(thirtyTwoCorePolicy.cpuTokens).toBe(23);
        expect(thirtyTwoCorePolicy.nativeProcesses).toBe(15);
        expect(thirtyTwoCorePolicy.ioWeight).toBe(4);
        expect(thirtyTwoCorePolicy.serializeStages).toBe(false);
        expect(thirtyTwoCorePolicy.rasterConcurrency + (thirtyTwoCorePolicy.sidecarThreads ?? 0)).toBeLessThanOrEqual(
            thirtyTwoCoreCap.cpuTokens - 1,
        );

        expect(partitionScanCleanupCpuBudget(1, 4)).toEqual({producerConcurrency: 1, sidecarMaxThreads: 1, totalCpuTokens: 1});
        expect(partitionScanCleanupCpuBudget(2, 4)).toEqual({producerConcurrency: 1, sidecarMaxThreads: 1, totalCpuTokens: 2});
    });

    it('clamps sidecar maxThreads to the active broker lease cpuTokens', async () => {
        const broker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 8,
            ioWeight: 8,
        });
        await broker.run(
            {
                ownerId: 'scan-cleanup:1:owner',
                kind: 'scan-cleanup-preview',
                priority: 'visible',
                resources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 180 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
            },
            async (brokerRun) => {
                expect(resolveScanCleanupSidecarMaxThreads({brokerRun})).toBe(1);
                expect(resolveScanCleanupSidecarMaxThreads({brokerRun, maxThreads: 6})).toBe(1);
            },
        );
        await broker.run(
            {
                ownerId: 'scan-cleanup:1:owner',
                kind: 'scan-cleanup',
                priority: 'user',
                resources: {
                    cpuTokens: 8,
                    estimatedResidentBytes: 512 * MIB,
                    nativeProcesses: 4,
                    ioWeight: 4,
                },
            },
            async (brokerRun) => {
                expect(resolveScanCleanupSidecarMaxThreads({brokerRun, maxThreads: 5})).toBe(5);
                expect(resolveScanCleanupSidecarMaxThreads({brokerRun, maxThreads: 12})).toBe(8);
            },
        );
    });
});

describe('O-3: phase-boundary lease transition for multi-page evb-pdf-image-combine', () => {
    it('releases the conversion lease before acquiring a multi-thread combine lease without nesting', async () => {
        const profile = createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB});
        const capacity = resolveMainJobBrokerCapacity(profile);
        const broker = new JobBroker(capacity);
        const controller = new AbortController();

        const observed: Array<{
            phase: string;
            activeCount: number;
            usedCpuTokens: number;
            combineThreads?: number;
            conversionLeaseStillActive?: boolean;
        }> = [];
        let initialConversionLease: IJobBrokerLease | undefined;

        await runWithScanCleanupConversionPhaseBroker(
            {
                broker,
                ownerId: 'scan-cleanup:1:doc',
                conversionResources: {
                    cpuTokens: 12,
                    estimatedResidentBytes: 7 * 180 * MIB,
                    nativeProcesses: 7,
                    ioWeight: 4,
                },
                logicalCpus: profile.logicalCpus,
                signal: controller.signal,
            },
            async (phaseBroker) => {
                const conversionRun = phaseBroker.getCurrentBrokerRun();
                expect(conversionRun).toBeDefined();
                initialConversionLease = conversionRun!.lease;
                observed.push({
                    phase: 'conversion-before-combine',
                    activeCount: broker.getSnapshot().active,
                    usedCpuTokens: broker.getSnapshot().used.cpuTokens,
                });

                await phaseBroker.runWithCombineLease(10, controller.signal, async (combineBrokerRun: IJobBrokerRunContext) => {
                    // Conversion lease MUST already be released — never nested!
                    expect(broker.isActive(initialConversionLease!)).toBe(false);
                    expect(broker.getSnapshot().active).toBe(1);
                    expect(phaseBroker.getCurrentBrokerRun()).toBeUndefined();
                    const combineThreads = resolvePdfImageCombineThreads(combineBrokerRun.lease.resources);
                    observed.push({
                        phase: 'combine',
                        activeCount: broker.getSnapshot().active,
                        usedCpuTokens: broker.getSnapshot().used.cpuTokens,
                        combineThreads,
                        conversionLeaseStillActive: broker.isActive(initialConversionLease!),
                    });
                });

                const restoredRun = phaseBroker.getCurrentBrokerRun();
                expect(restoredRun).toBeDefined();
                expect(broker.getSnapshot().active).toBe(1);
                observed.push({
                    phase: 'conversion-after-combine',
                    activeCount: broker.getSnapshot().active,
                    usedCpuTokens: broker.getSnapshot().used.cpuTokens,
                });
            },
        );

        expect(broker.getSnapshot().active).toBe(0);
        expect(observed).toEqual([
            {phase: 'conversion-before-combine', activeCount: 1, usedCpuTokens: 12},
            {phase: 'combine', activeCount: 1, usedCpuTokens: 10, combineThreads: 10, conversionLeaseStillActive: false},
            {phase: 'conversion-after-combine', activeCount: 1, usedCpuTokens: 12},
        ]);
    });

    it('bounds combine width to 1 thread on 2-core / 4 GiB hosts and scales on 16-core / 32 GiB hosts', () => {
        const twoCore = createHostProfile({logicalCpus: 2, totalRamBytes: 4 * GIB});
        const twoCoreCombine = resolveScanCleanupCombineLeaseResources(resolveMainJobBrokerCapacity(twoCore), 20, twoCore.logicalCpus);
        expect(resolvePdfImageCombineThreads(twoCoreCombine)).toBe(1);
        expect(twoCoreCombine.cpuTokens).toBe(1);

        const sixteenCore = createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB});
        const sixteenCoreCombine = resolveScanCleanupCombineLeaseResources(
            resolveMainJobBrokerCapacity(sixteenCore),
            20,
            sixteenCore.logicalCpus,
        );
        expect(resolvePdfImageCombineThreads(sixteenCoreCombine)).toBe(11);
        expect(sixteenCoreCombine.cpuTokens).toBe(11);
        expect(sixteenCoreCombine.ioWeight).toBe(4);

        const eightCore8Gib = createHostProfile({logicalCpus: 8, totalRamBytes: 8 * GIB});
        const eightCoreCombine = resolveScanCleanupCombineLeaseResources(
            resolveMainJobBrokerCapacity(eightCore8Gib),
            10,
            eightCore8Gib.logicalCpus,
        );
        expect(resolvePdfImageCombineThreads(eightCoreCombine)).toBe(5);
        expect(eightCoreCombine.cpuTokens).toBe(5);
        expect(eightCoreCombine.ioWeight).toBe(3);

        const threePageCombine = resolveScanCleanupCombineLeaseResources(
            resolveMainJobBrokerCapacity(sixteenCore),
            3,
            sixteenCore.logicalCpus,
        );
        expect(resolvePdfImageCombineThreads(threePageCombine)).toBe(3);
    });

    it('keeps single-page exports on the conversion lease without triggering a combine lease transition', async () => {
        const runWithCombineLease = vi.fn(async (_pages, _signal, work) => work(harness.dependencies.runCommand));
        const harness = await createConversionHarness({
            pageCount: 1,
            runWithCombineLease,
        });

        await runScanCleanupConversion(
            {
                sourcePdfPath: harness.sourcePdfPath,
                outputPdfPath: harness.outputPdfPath,
                options: harness.options,
            },
            harness.paths,
            new AbortController().signal,
            () => undefined,
            {rasterConcurrency: 4, logicalCpus: 16, totalRamBytes: 32 * GIB},
            () => undefined,
            harness.dependencies,
        );

        expect(runWithCombineLease).not.toHaveBeenCalled();
        expect(harness.combineCalls).toHaveLength(1);
    });

    it('transitions through runWithCombineLease for multi-page exports', async () => {
        const profile = createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB});
        const broker = new JobBroker(resolveMainJobBrokerCapacity(profile));
        const controller = new AbortController();
        const harness = await createConversionHarness({pageCount: 4});
        let combinePhaseThreads = 0;

        await runWithScanCleanupConversionPhaseBroker(
            {
                broker,
                ownerId: 'scan-cleanup:1:multi',
                conversionResources: {
                    cpuTokens: 12,
                    estimatedResidentBytes: 7 * 180 * MIB,
                    nativeProcesses: 7,
                    ioWeight: 4,
                },
                logicalCpus: profile.logicalCpus,
                signal: controller.signal,
            },
            async (phaseBroker) => {
                const originalRunCombine = phaseBroker.runWithCombineLease;
                const observedPhaseBroker = {
                    ...phaseBroker,
                    runWithCombineLease: <T>(
                        outputPageCount: number,
                        sig: AbortSignal,
                        work: (combineBrokerRun: IJobBrokerRunContext) => Promise<T>,
                    ) =>
                        originalRunCombine(outputPageCount, sig, async (combineBrokerRun) => {
                            combinePhaseThreads = resolvePdfImageCombineThreads(combineBrokerRun.lease.resources);
                            return work(combineBrokerRun);
                        }),
                };
                await runScanCleanupPipeline(
                    {
                        sourcePdfPath: harness.sourcePdfPath,
                        outputPdfPath: harness.outputPdfPath,
                        options: harness.options,
                    },
                    harness.paths,
                    controller.signal,
                    () => undefined,
                    {rasterConcurrency: 7, logicalCpus: 16, totalRamBytes: 32 * GIB},
                    () => undefined,
                    harness.dependencies,
                    {phaseBroker: observedPhaseBroker},
                );
            },
        );

        expect(combinePhaseThreads).toBe(4);
        expect(broker.getSnapshot().active).toBe(0);
    });

    it('releases cleanly without leaking leases when aborted during phase transition or combine', async () => {
        const profile = createHostProfile({logicalCpus: 8, totalRamBytes: 16 * GIB});
        const capacity = resolveMainJobBrokerCapacity(profile);
        const broker = new JobBroker(capacity);

        // 1. Abort while queued waiting for combine lease (after conversion lease released).
        const abortWhileWaitingForCombine = new AbortController();
        const blocker = await broker.acquire({
            ownerId: 'other-owner',
            kind: 'other-job',
            priority: 'user',
            resources: {
                cpuTokens: 2,
                estimatedResidentBytes: 512 * MIB,
                nativeProcesses: 1,
                ioWeight: 2,
            },
        });
        // Hold another blocker so conversion (cpuTokens: 1, ioWeight: 1) fits
        // while combine (cpuTokens: 5, ioWeight: 3) queues until aborted.
        const runPromise = runWithScanCleanupConversionPhaseBroker(
            {
                broker,
                ownerId: 'scan-cleanup:1:abort-transition',
                conversionResources: {
                    cpuTokens: 1,
                    estimatedResidentBytes: 180 * MIB,
                    nativeProcesses: 1,
                    ioWeight: 1,
                },
                logicalCpus: profile.logicalCpus,
                signal: abortWhileWaitingForCombine.signal,
            },
            async (phaseBroker) => {
                const pendingCombine = phaseBroker.runWithCombineLease(6, abortWhileWaitingForCombine.signal, async () => {
                    throw new Error('combine should not start while blocked');
                });
                // Yield until conversion lease is released and combine is queued.
                await vi.waitFor(() => expect(broker.getSnapshot().active).toBe(1));
                expect(broker.getSnapshot().queued).toBe(1);
                abortWhileWaitingForCombine.abort(new DOMException('Canceled during transition', 'AbortError'));
                await pendingCombine;
            },
        );
        await expect(runPromise).rejects.toMatchObject({name: 'AbortError', message: 'Canceled during transition'});
        blocker.release();
        expect(broker.getSnapshot().active).toBe(0);
        expect(broker.getSnapshot().queued).toBe(0);

        // 2. Abort inside combine execution.
        const abortInsideCombine = new AbortController();
        await expect(
            runWithScanCleanupConversionPhaseBroker(
                {
                    broker,
                    ownerId: 'scan-cleanup:1:abort-combine',
                    conversionResources: {
                        cpuTokens: 2,
                        estimatedResidentBytes: 360 * MIB,
                        nativeProcesses: 2,
                        ioWeight: 2,
                    },
                    logicalCpus: profile.logicalCpus,
                    signal: abortInsideCombine.signal,
                },
                async (phaseBroker) => {
                    await phaseBroker.runWithCombineLease(6, abortInsideCombine.signal, async () => {
                        abortInsideCombine.abort(new DOMException('Canceled mid-combine', 'AbortError'));
                        abortInsideCombine.signal.throwIfAborted();
                    });
                },
            ),
        ).rejects.toThrow();
        expect(broker.getSnapshot().active).toBe(0);
        expect(broker.getSnapshot().queued).toBe(0);
    });
});

describe('O-10: preview PPM retention, sourceDpiCandidate reuse, and no-op qpdf --check skip', () => {
    it('retains internal path-only preview rasters as PPM and transparently encodes PNG on later byte reads', async () => {
        const {dir, deps} = await createScanCleanupPreviewTestContext(tempDirs);
        const retention = scanCleanupRasterRetention(deps);
        try {
            const doc = await retention.openDocument(
                {sourcePdfPath: join(dir, 'source.pdf'), documentRevision: 'ppm-retention'},
                'owner-1',
            );
            const pathOnly = await retention.materializeRawRasterPath(
                doc,
                1,
                new AbortController().signal,
                deps,
                1,
                300,
                undefined,
                'owner-1',
            );
            expect(deps.renderPagePpm).toHaveBeenCalledTimes(1);
            expect(deps.renderPage).not.toHaveBeenCalled();
            const diskBytes = await readFile(pathOnly.path);
            expect(diskBytes.subarray(0, 2).toString('ascii')).toBe('P6');

            // A subsequent byte-level read of the same page/DPI encodes PNG from the retained PPM without re-rendering.
            const withBytes = await retention.materializeRawRaster(
                doc,
                1,
                new AbortController().signal,
                deps,
                1,
                300,
                undefined,
                'owner-1',
            );
            expect(deps.renderPage).not.toHaveBeenCalled();
            expect(deps.renderPagePpm).toHaveBeenCalledTimes(1);
            expect(Buffer.from(withBytes.bytes.subarray(0, 8)).toString('hex')).toBe('89504e470d0a1a0a');
            await retention.release(doc, 'owner-1');
        } finally {
            await retention.dispose();
        }
    });

    it('derives sourceDpiCandidate from boundedRasterPage without running a duplicate detectSourceDpi probe', async () => {
        const {deps} = await createScanCleanupPreviewTestContext(tempDirs);
        deps.detectSourceDpi = vi.fn(async () => 300);
        deps.detectRasterPages = vi.fn(async () =>
            createScanCleanupPageRasterSource({
                pages: [1],
                sourceDpiByPage: new Map([[1, 240]]),
            }),
        );
        let observedSourceDpi: number | undefined;
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                pages: Array<{options: {sourceDpi: number}}>;
            };
            observedSourceDpi = manifest.pages[0]?.options.sourceDpi;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        const service = scanCleanupPreviewLifecycle(deps);
        try {
            await previewOf(service, sender(), {
                ...previewRequest,
                requestId: requireRequestId('reuse-bounded-dpi'),
                options: {
                    ...previewRequest.options,
                    matchPageSize: false,
                },
                layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
                layoutDetectionComplete: true,
            });
            expect(deps.detectRasterPages).toHaveBeenCalledOnce();
            expect(deps.detectSourceDpi).not.toHaveBeenCalled();
            expect(observedSourceDpi).toBe(240);
        } finally {
            await service.dispose();
        }
    });

    it('skips the duplicate qpdf --check ONLY when text overlay is a verified no-op, and keeps checking when overlay modifies bytes', async () => {
        // 1. Single-batch lossless (verified no-op text overlay: 0 overlay pages): 1 qpdf --check instead of 2.
        const losslessHarness = await createConversionHarness({
            pageCount: 2,
            preserveOriginalQuality: true,
        });
        await runScanCleanupConversion(
            {
                sourcePdfPath: losslessHarness.sourcePdfPath,
                outputPdfPath: losslessHarness.outputPdfPath,
                options: losslessHarness.options,
            },
            losslessHarness.paths,
            new AbortController().signal,
            () => undefined,
            {rasterConcurrency: 2, logicalCpus: 8, totalRamBytes: 16 * GIB},
            () => undefined,
            losslessHarness.dependencies,
        );
        expect(losslessHarness.qpdfChecks).toHaveLength(1);

        // 2. Active text overlay (bytes modified by evb-pdf-page-ops overlay-text): NEVER skips post-overlay validation.
        const modifiedHarness = await createConversionHarness({pageCount: 2, withOverlayText: true});
        await runScanCleanupConversion(
            {
                sourcePdfPath: modifiedHarness.sourcePdfPath,
                outputPdfPath: modifiedHarness.outputPdfPath,
                options: modifiedHarness.options,
            },
            modifiedHarness.paths,
            new AbortController().signal,
            () => undefined,
            {rasterConcurrency: 2, logicalCpus: 8, totalRamBytes: 16 * GIB},
            () => undefined,
            modifiedHarness.dependencies,
        );
        expect(modifiedHarness.qpdfChecks).toHaveLength(2);

        // 3. Link-only raster overlay still rewrites stagedPdfPath via evb-pdf-page-ops: NEVER skips post-overlay validation.
        const linkOnlyHarness = await createConversionHarness({pageCount: 2, withOverlayText: false});
        await runScanCleanupConversion(
            {
                sourcePdfPath: linkOnlyHarness.sourcePdfPath,
                outputPdfPath: linkOnlyHarness.outputPdfPath,
                options: linkOnlyHarness.options,
            },
            linkOnlyHarness.paths,
            new AbortController().signal,
            () => undefined,
            {rasterConcurrency: 2, logicalCpus: 8, totalRamBytes: 16 * GIB},
            () => undefined,
            linkOnlyHarness.dependencies,
        );
        expect(linkOnlyHarness.qpdfChecks).toHaveLength(2);
    });

    it('preserves immediate visible preview headroom across CPU, processes, memory, and I/O on every host profile in conversion and combine phases', async () => {
        const profiles = [
            createHostProfile({logicalCpus: 2, totalRamBytes: 4 * GIB}),
            createHostProfile({logicalCpus: 8, totalRamBytes: 8 * GIB}),
            createHostProfile({logicalCpus: 8, totalRamBytes: 16 * GIB, tier: 'medium', detectedTier: 'medium'}),
            createHostProfile({logicalCpus: 16, totalRamBytes: 8 * GIB}),
            createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB, performanceMode: 'low', tier: 'low'}),
            createHostProfile({logicalCpus: 16, totalRamBytes: 32 * GIB}),
            createHostProfile({logicalCpus: 32, totalRamBytes: 10 * GIB, tier: 'high', detectedTier: 'high'}),
        ];
        for (const profile of profiles) {
            const capacity = resolveMainJobBrokerCapacity(profile);
            const broker = new JobBroker(capacity, {
                maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
                interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
            });
            const policy = resolveScanCleanupPreviewRasterAdmissionPolicy(capacity, baseCleanupOptions, profile.logicalCpus, {
                overlapSidecarProcess: true,
            });
            const slotBytes = resolveScanCleanupPreviewRasterSlotResidentBytes(baseCleanupOptions, policy.rasterMaxPixels);
            // Overlapping conversion leases must explicitly cover producers + sidecar.
            if (!policy.serializeStages) {
                expect(policy.nativeProcesses).toBe(policy.rasterConcurrency + 1);
            }
            const assertVisiblePreviewAdmitted = async (phaseLabel: string) => {
                const beforeSnapshot = broker.getSnapshot();
                // Memory and I/O must fit within bulk capacity on every profile;
                // hosts with >1 bulk CPU/process slot must also preserve bulk CPU/process headroom.
                expect(beforeSnapshot.usedBulk.estimatedResidentBytes + slotBytes).toBeLessThanOrEqual(capacity.estimatedResidentBytes);
                expect(beforeSnapshot.usedBulk.ioWeight + 1).toBeLessThanOrEqual(capacity.ioWeight);
                if (capacity.cpuTokens > 1 && capacity.nativeProcesses > 1) {
                    expect(beforeSnapshot.usedBulk.cpuTokens + 1).toBeLessThanOrEqual(capacity.cpuTokens);
                    expect(beforeSnapshot.usedBulk.nativeProcesses + 1).toBeLessThanOrEqual(capacity.nativeProcesses);
                }
                let previewAdmitted = false;
                const previewAbort = new AbortController();
                const previewPromise = broker.run(
                    createScanCleanupPreviewBrokerRequest({
                        ownerId: 'scan-cleanup:2:preview',
                        visibility: 'visible',
                        estimatedResidentBytes: slotBytes,
                        signal: previewAbort.signal,
                    }),
                    async () => {
                        previewAdmitted = true;
                        // Heavy visible previews burst CPU/process slots from the
                        // interactive reserve without overcommitting bulk static memory.
                        expect(broker.getSnapshot().usedBulk.estimatedResidentBytes).toBeLessThanOrEqual(capacity.estimatedResidentBytes);
                    },
                );
                // If the preview queued behind the phase lease, abort it immediately
                // so the test reports the failing phase instead of hanging.
                if (broker.getSnapshot().queued > 0) {
                    previewAbort.abort(new Error(`Visible preview queued during ${phaseLabel}`));
                }
                await previewPromise;
                expect(previewAdmitted).toBe(true);
            };
            await runWithScanCleanupConversionPhaseBroker(
                {
                    broker,
                    ownerId: 'scan-cleanup:1:conversion',
                    conversionResources: {
                        cpuTokens: policy.cpuTokens ?? policy.rasterConcurrency,
                        estimatedResidentBytes: policy.rasterConcurrency * slotBytes,
                        nativeProcesses: policy.nativeProcesses ?? policy.rasterConcurrency,
                        ioWeight: policy.ioWeight ?? 3,
                    },
                    logicalCpus: profile.logicalCpus,
                    signal: new AbortController().signal,
                },
                async (phaseBroker) => {
                    await assertVisiblePreviewAdmitted(`conversion (${profile.logicalCpus}c/${profile.totalRamBytes / GIB}GiB)`);
                    await phaseBroker.runWithCombineLease(10, new AbortController().signal, async () => {
                        await assertVisiblePreviewAdmitted(`combine (${profile.logicalCpus}c/${profile.totalRamBytes / GIB}GiB)`);
                    });
                },
            );
        }
    });

    it('keeps 2c/4GiB prefetch previews queued and gates visible previews on live OS memory headroom during conversion and combine', async () => {
        const twoCoreProfile = createHostProfile({logicalCpus: 2, totalRamBytes: 4 * GIB});
        const capacity = resolveMainJobBrokerCapacity(twoCoreProfile);
        const policy = resolveScanCleanupPreviewRasterAdmissionPolicy(capacity, baseCleanupOptions, twoCoreProfile.logicalCpus, {
            overlapSidecarProcess: true,
        });
        const slotBytes = resolveScanCleanupPreviewRasterSlotResidentBytes(baseCleanupOptions, policy.rasterMaxPixels);

        let availableBytes = 2 * GIB;
        const broker = new JobBroker(capacity, {
            maxInteractiveJobResources: MAIN_JOB_BROKER_MAX_INTERACTIVE_JOB_RESOURCES,
            interactiveReserve: MAIN_JOB_BROKER_INTERACTIVE_RESERVE,
            readSystemMemoryInfo: () => ({
                totalBytes: 4 * GIB,
                availableBytes,
                freeBytes: 512 * MIB,
            }),
            memoryPressurePollIntervalMs: 0,
        });

        await runWithScanCleanupConversionPhaseBroker(
            {
                broker,
                ownerId: 'scan-cleanup:1:conversion',
                conversionResources: {
                    cpuTokens: policy.cpuTokens ?? policy.rasterConcurrency,
                    estimatedResidentBytes: policy.rasterConcurrency * slotBytes,
                    nativeProcesses: policy.nativeProcesses ?? policy.rasterConcurrency,
                    ioWeight: policy.ioWeight ?? 3,
                },
                logicalCpus: twoCoreProfile.logicalCpus,
                signal: new AbortController().signal,
            },
            async (phaseBroker) => {
                // Background prefetch remains bulk and must queue behind 2c/4GiB conversion.
                const prefetchAbort = new AbortController();
                const prefetchPromise = broker.run(
                    createScanCleanupPreviewBrokerRequest({
                        ownerId: 'scan-cleanup:2:prefetch',
                        visibility: 'prefetch',
                        estimatedResidentBytes: slotBytes,
                        signal: prefetchAbort.signal,
                    }),
                    async () => undefined,
                );
                expect(broker.getSnapshot().queued).toBe(1);
                prefetchAbort.abort(new Error('expected prefetch to queue on 2c/4GiB'));
                await expect(prefetchPromise).rejects.toThrow('expected prefetch to queue on 2c/4GiB');

                // Tight live OS RAM (950 MiB available: fits when idle at 822 MiB headroom,
                // but blocked under the 512 MiB active bulk live floor -> 438 MiB < 610 MiB)
                // must gate visible previews during BOTH conversion and combine to prevent OOM.
                availableBytes = 950 * MIB;
                const oomConversionAbort = new AbortController();
                const oomConversionPromise = broker.run(
                    createScanCleanupPreviewBrokerRequest({
                        ownerId: 'scan-cleanup:2:preview',
                        visibility: 'visible',
                        estimatedResidentBytes: slotBytes,
                        signal: oomConversionAbort.signal,
                    }),
                    async () => undefined,
                );
                expect(broker.getSnapshot().queued).toBe(1);
                oomConversionAbort.abort(new Error('expected visible preview to queue under low live RAM during conversion'));
                await expect(oomConversionPromise).rejects.toThrow(
                    'expected visible preview to queue under low live RAM during conversion',
                );

                // Healthy live RAM admits the visible preview immediately during conversion.
                availableBytes = 2 * GIB;
                let conversionPreviewAdmitted = false;
                await broker.run(
                    createScanCleanupPreviewBrokerRequest({
                        ownerId: 'scan-cleanup:2:preview',
                        visibility: 'visible',
                        estimatedResidentBytes: slotBytes,
                        signal: new AbortController().signal,
                    }),
                    async () => {
                        conversionPreviewAdmitted = true;
                    },
                );
                expect(conversionPreviewAdmitted).toBe(true);

                await phaseBroker.runWithCombineLease(10, new AbortController().signal, async () => {
                    availableBytes = 950 * MIB;
                    const oomCombineAbort = new AbortController();
                    const oomCombinePromise = broker.run(
                        createScanCleanupPreviewBrokerRequest({
                            ownerId: 'scan-cleanup:2:preview',
                            visibility: 'visible',
                            estimatedResidentBytes: slotBytes,
                            signal: oomCombineAbort.signal,
                        }),
                        async () => undefined,
                    );
                    expect(broker.getSnapshot().queued).toBe(1);
                    oomCombineAbort.abort(new Error('expected visible preview to queue under low live RAM during combine'));
                    await expect(oomCombinePromise).rejects.toThrow('expected visible preview to queue under low live RAM during combine');

                    availableBytes = 2 * GIB;
                    let combinePreviewAdmitted = false;
                    await broker.run(
                        createScanCleanupPreviewBrokerRequest({
                            ownerId: 'scan-cleanup:2:preview',
                            visibility: 'visible',
                            estimatedResidentBytes: slotBytes,
                            signal: new AbortController().signal,
                        }),
                        async () => {
                            combinePreviewAdmitted = true;
                        },
                    );
                    expect(combinePreviewAdmitted).toBe(true);
                });
            },
        );
    });

    it('serializes producer and sidecar consumer stages when serializeStages is enabled on 1-token leases', async () => {
        let activeProduce = 0;
        let activeConsume = 0;
        let overlapObserved = false;
        const consumedChunks: number[][] = [];

        await runBoundedRasterProducerConsumer({
            items: [1, 2, 3, 4, 5],
            budget: {
                producerConcurrency: 1,
                maxChunkPages: 2,
                maxInFlightPages: 4,
                maxInFlightBytes: 1024 * 1024,
                serializeStages: true,
            },
            signal: new AbortController().signal,
            estimateItemBytes: () => 1024,
            produce: async (item) => {
                activeProduce += 1;
                if (activeConsume > 0) {
                    overlapObserved = true;
                }
                await Promise.resolve();
                await Promise.resolve();
                activeProduce -= 1;
                return {staged: item, actualBytes: 1024};
            },
            consumeChunk: async (chunk) => {
                activeConsume += 1;
                if (activeProduce > 0) {
                    overlapObserved = true;
                }
                await Promise.resolve();
                await Promise.resolve();
                consumedChunks.push([...chunk]);
                activeConsume -= 1;
            },
            cleanupStaged: async () => undefined,
        });

        expect(overlapObserved).toBe(false);
        expect(consumedChunks).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('propagates unproven native termination before combine transition instead of stranding behind a retained conversion lease', async () => {
        const broker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 8,
            ioWeight: 8,
        });
        const harness = await createConversionHarness({pageCount: 2});
        const unprovenError = markUnprovenNativeTermination(
            new Error('pdfimages timed out without termination proof'),
            'pdfimages process tree (pid=9001) was not proven dead',
        );
        // Inject an unproven-termination failure from MRC extraction on a multi-page conversion.
        harness.dependencies.extractMrcLayersBatch = vi.fn(async () => {
            throw unprovenError;
        });
        const phaseController = new AbortController();
        let combineCalled = false;

        await expect(
            runWithScanCleanupConversionPhaseBroker(
                {
                    broker,
                    ownerId: 'scan-cleanup:1:mrc-unproven',
                    conversionResources: {
                        cpuTokens: 2,
                        estimatedResidentBytes: 512 * MIB,
                        nativeProcesses: 2,
                        ioWeight: 3,
                    },
                    logicalCpus: 8,
                    signal: phaseController.signal,
                },
                async (phaseBroker) => {
                    const activeRun = phaseBroker.getCurrentBrokerRun();
                    activeRun?.onTerminationProof(Promise.resolve(false));
                    // Verify direct phase-transition defense-in-depth: transitioning after an
                    // unproven conversion proof rejects cleanly instead of queuing on perOwnerLimit: 1.
                    await phaseBroker.runWithCombineLease(2, phaseController.signal, async () => {
                        combineCalled = true;
                    });
                },
            ),
        ).rejects.toSatisfy((error: unknown) => getUnprovenNativeTerminationDetail(error) !== undefined);
        expect(combineCalled).toBe(false);
        // The retained conversion lease stays charged on the broker.
        expect(broker.getSnapshot().active).toBe(1);

        // Also verify conversion MRC fallback rethrows marked unproven-termination errors instead of continuing.
        const mrcBroker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 8,
            ioWeight: 8,
        });
        const mrcHarness = await createConversionHarness({pageCount: 2});
        mrcHarness.dependencies.getPageSizeStore = vi.fn(async () =>
            createArrayBackedPdfPageSizeStore(
                [1, 2].map((pageNumber) => ({
                    pageNumber,
                    xPoints: 0,
                    yPoints: 0,
                    widthPoints: 612,
                    heightPoints: 792,
                    mediaXPoints: 0,
                    mediaYPoints: 0,
                    mediaWidthPoints: 612,
                    mediaHeightPoints: 792,
                    cropXPoints: 0,
                    cropYPoints: 0,
                    cropWidthPoints: 612,
                    cropHeightPoints: 792,
                    dominantImageWidthPoints: 612,
                    dominantImageHeightPoints: 792,
                    dominantImageWidthPx: 2550,
                    dominantImageHeightPx: 3300,
                    allImagesPageAligned: true,
                    rotation: 0,
                })),
            ),
        );
        mrcHarness.dependencies.detectSourceDpi = vi.fn(async () => ({
            detected: true,
            documentDpi: 300,
            getPageRaster: () => ({dpi: 300, width: 2550, height: 3300, hasBilevelLayer: true, backgroundDpi: 150}),
        }));
        mrcHarness.dependencies.extractMrcLayersBatch = vi.fn(async () => {
            throw unprovenError;
        });
        await expect(
            runWithScanCleanupConversionPhaseBroker(
                {
                    broker: mrcBroker,
                    ownerId: 'scan-cleanup:1:mrc-fallback',
                    conversionResources: {
                        cpuTokens: 2,
                        estimatedResidentBytes: 512 * MIB,
                        nativeProcesses: 2,
                        ioWeight: 3,
                    },
                    logicalCpus: 8,
                    signal: new AbortController().signal,
                },
                async (phaseBroker) =>
                    runScanCleanupPipeline(
                        {
                            sourcePdfPath: mrcHarness.sourcePdfPath,
                            outputPdfPath: mrcHarness.outputPdfPath,
                            options: {...mrcHarness.options, outputMode: 'bw'},
                        },
                        mrcHarness.paths,
                        new AbortController().signal,
                        () => undefined,
                        {rasterConcurrency: 2, logicalCpus: 8, totalRamBytes: 16 * GIB},
                        () => undefined,
                        mrcHarness.dependencies,
                        {phaseBroker},
                    ),
            ),
        ).rejects.toBe(unprovenError);
        expect(mrcHarness.dependencies.extractMrcLayersBatch).toHaveBeenCalledOnce();
        expect(mrcHarness.combineCalls).toHaveLength(0);
    });

    it('propagates unproven native termination from geometry-backed preview raster probes instead of falling back', async () => {
        const dirs: string[] = [];
        const {deps} = await createScanCleanupPreviewTestContext(dirs);
        tempDirs.push(...dirs);
        const unprovenProbeError = markUnprovenNativeTermination(
            new Error('pdfimages -list timed out'),
            'pdfimages process tree (pid=7777) was not proven dead',
        );
        deps.detectRasterPages = vi.fn(async () => {
            throw unprovenProbeError;
        });

        const service = scanCleanupPreviewLifecycle(deps);
        try {
            await expect(
                previewOf(service, sender(), {
                    ...previewRequest,
                    requestId: requireRequestId('unproven-probe-preview'),
                    options: {
                        ...previewRequest.options,
                        matchPageSize: false,
                    },
                    layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
                    layoutDetectionComplete: true,
                }),
            ).rejects.toThrow('pdfimages -list timed out');
            expect(deps.runSidecar).not.toHaveBeenCalled();
        } finally {
            await service.dispose();
        }
    });

    it('rejects combine transition when a conversion lease is retained by a pending proof or a raw leaseTerminationProof failure', async () => {
        // 1. Pending proof that resolves false AFTER release(): broker retains the lease, so combine must reject rather than deadlock.
        const pendingBroker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 8,
            ioWeight: 8,
        });
        const deferredProof = Promise.withResolvers<boolean>();
        try {
            await expect(
                runWithScanCleanupConversionPhaseBroker(
                    {
                        broker: pendingBroker,
                        ownerId: 'scan-cleanup:1:pending-proof',
                        conversionResources: {
                            cpuTokens: 2,
                            estimatedResidentBytes: 512 * MIB,
                            nativeProcesses: 2,
                            ioWeight: 3,
                        },
                        logicalCpus: 8,
                        signal: new AbortController().signal,
                    },
                    async (phaseBroker) => {
                        phaseBroker.getCurrentBrokerRun()?.onTerminationProof(deferredProof.promise);
                        await phaseBroker.runWithCombineLease(2, new AbortController().signal, async () => undefined);
                    },
                ),
            ).rejects.toSatisfy((error: unknown) => getUnprovenNativeTerminationDetail(error) !== undefined);
        } finally {
            deferredProof.resolve(false);
        }
        await Promise.resolve();
        expect(pendingBroker.getSnapshot()).toMatchObject({active: 1, queued: 0});

        // 2. False proof recorded via raw leaseTerminationProof (as assertNativeToolBuild does for --build-id).
        const rawProofBroker = new JobBroker({
            cpuTokens: 8,
            estimatedResidentBytes: 8 * GIB,
            nativeProcesses: 8,
            ioWeight: 8,
        });
        await expect(
            runWithScanCleanupConversionPhaseBroker(
                {
                    broker: rawProofBroker,
                    ownerId: 'scan-cleanup:1:raw-proof',
                    conversionResources: {
                        cpuTokens: 2,
                        estimatedResidentBytes: 512 * MIB,
                        nativeProcesses: 2,
                        ioWeight: 3,
                    },
                    logicalCpus: 8,
                    signal: new AbortController().signal,
                },
                async (phaseBroker) => {
                    const currentRun = phaseBroker.getCurrentBrokerRun();
                    expect(currentRun?.leaseTerminationProof).toBeDefined();
                    currentRun!.leaseTerminationProof!(Promise.resolve(false));
                    await phaseBroker.runWithCombineLease(2, new AbortController().signal, async () => undefined);
                },
            ),
        ).rejects.toSatisfy((error: unknown) => getUnprovenNativeTerminationDetail(error) !== undefined);
        expect(rawProofBroker.getSnapshot()).toMatchObject({active: 1, queued: 0});
    });

    it('preserves the finer dominant bilevel mask DPI during preview without running a duplicate detectSourceDpi probe', async () => {
        const dirs: string[] = [];
        const {deps} = await createScanCleanupPreviewTestContext(dirs);
        tempDirs.push(...dirs);
        // Geometry reports a 150-DPI full-page background image, while the batched
        // structure probe discovers a 300-DPI dominant 1-bit soft mask.
        deps.getPageSizes = vi.fn(async () => [
            {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                dominantImageWidthPoints: 612,
                dominantImageHeightPoints: 792,
                dominantImageWidthPx: 1275,
                dominantImageHeightPx: 1650,
                rotation: 0,
            },
        ]);
        deps.detectRasterPages = vi.fn(async () => ({
            detected: true,
            documentDpi: 300,
            getPageRaster: (pageNumber: number) =>
                pageNumber === 1
                    ? {
                          dpi: 300,
                          width: 2550,
                          height: 3300,
                          hasBilevelLayer: true,
                          hasDominantBilevelLayer: true,
                          backgroundDpi: 150,
                      }
                    : undefined,
        }));
        deps.detectSourceDpi = vi.fn(async () => 300);
        let observedSourceDpi: number | undefined;
        const originalSidecar = deps.runSidecar;
        deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                pages: Array<{options: {sourceDpi?: number}}>;
            };
            observedSourceDpi = manifest.pages[0]?.options.sourceDpi;
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
        });

        const service = scanCleanupPreviewLifecycle(deps);
        try {
            await previewOf(service, sender(), {
                ...previewRequest,
                requestId: requireRequestId('masked-scan-finer-grid'),
                options: {
                    ...previewRequest.options,
                    outputMode: 'bw',
                    matchPageSize: false,
                },
                layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
                layoutDetectionComplete: true,
            });
            expect(deps.detectRasterPages).toHaveBeenCalledOnce();
            expect(deps.detectSourceDpi).not.toHaveBeenCalled();
            expect(observedSourceDpi).toBe(300);
        } finally {
            await service.dispose();
        }
    });
});
