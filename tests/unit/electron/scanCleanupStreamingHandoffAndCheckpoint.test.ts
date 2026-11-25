import {createHash} from 'node:crypto';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {Worker} from 'node:worker_threads';
import {build as buildWithEsbuild} from 'esbuild';
import {encode as encodePng} from 'fast-png';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IScanCleanupOptions,
    TScanCleanupProgress,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {getUnprovenNativeTerminationDetail} from '@contracts/nativeErrors';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {requirePageNumber} from '@contracts/pageNumbers';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {JobBroker} from '@electron/resources/jobBroker';
import {
    computeScanCleanupCheckpointWitness,
    computeScanCleanupRenderPlanSignature,
    openScanCleanupConversionCheckpoint,
    reclaimScanCleanupCheckpoint,
    reclaimScanCleanupCheckpointOwner,
} from '@evb/scan-cleanup/core/conversionCheckpoint';
import {createFileBackedScanCleanupDetectionResultStore} from '@evb/scan-cleanup/core/fileBackedResultStore';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {
    runScanCleanupConversion,
    type IRunScanCleanupPipelineDependencies,
    type IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/runScanCleanupConversion';
import {
    estimateRawRasterBytes,
    resolveStreamingRasterHandoffBudget,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {runBoundedRasterProducerConsumer} from '@evb/scan-cleanup/core/streamingRasterHandoff';
import type {
    IPdfPageSize,
    IScanCleanupStreamingHandoffLimits,
} from '@evb/scan-cleanup/core/types';
import {loadScanCleanupPipelineWithBatchPages} from '@tests/helpers/loadScanCleanupPipelineWithBatchPages';

const roots: string[] = [];

const PNG = Buffer.from(encodePng({
    width: 1,
    height: 1,
    data: new Uint8Array(3),
    channels: 3,
    depth: 8,
}));

function makePpm(width: number, height: number) {
    const header = Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, 'ascii');
    const pixels = Buffer.alloc(width * height * 3, 0x80);
    return Buffer.concat([
        header,
        pixels,
    ]);
}

const SMALL_PPM = makePpm(1, 1);

const baseOptions: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'color',
    readingOrder: 'ltr',
    thickness: 0,
    crop: false,
    matchPageSize: false,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 0,
        topMm: 0,
        rightMm: 0,
        bottomMm: 0,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};

const basePolicy: IScanCleanupRuntimePolicy = {
    rasterConcurrency: 2,
    logicalCpus: 8,
    totalRamBytes: 8 * 1024 ** 3,
};

function pageGeometry(pageNumber: number): IPdfPageSize {
    return {
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 72,
        heightPoints: 72,
        rotation: 0,
    };
}

function outputMetadata(half: 'full' | 'left' | 'right' = 'full') {
    return {
        outputWidthPx: 1,
        outputHeightPx: 1,
        canvasWidthPx: 1,
        canvasHeightPx: 1,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        rotationDegrees: 0,
        renderDpi: 300,
        layoutClassification: half === 'full' ? 'single-uncut-page' : 'two-page-spread',
        skewApplied: true,
        bilevelWritten: false,
        layeredWritten: false,
        half,
        outputMode: 'color',
        contentBox: {
            xPx: 0,
            yPx: 0,
            widthPx: 1,
            heightPx: 1,
        },
        warnings: [],
        warningEvents: [],
    };
}

function pageMetadata(overrides: {
    excluded?: boolean;
    layoutClassification?: 'single-uncut-page' | 'two-page-spread';
    outputCount?: number;
} = {}) {
    return {
        layoutClassification: overrides.layoutClassification ?? 'single-uncut-page',
        cutterXPx: overrides.layoutClassification === 'two-page-spread' ? 0.5 : null,
        rotationDegrees: 0,
        canvasScope: 'document',
        excluded: overrides.excluded ?? false,
        blankOutputsSkipped: 0,
        outputCount: overrides.outputCount ?? (overrides.excluded ? 0 : 1),
    };
}

async function listStagedSourceRasters(directory: string) {
    const entries = await readdir(directory).catch(() => []);
    return entries.filter(name => /^source-\d+(?:-analysis-\d+dpi)?\.(?:ppm|png)$/u.test(name));
}

async function measureStagedSourceBytes(directory: string) {
    const files = await listStagedSourceRasters(directory);
    const seenInodes = new Set<number>();
    let total = 0;
    for (const file of files) {
        try {
            const fileStat = await stat(join(directory, file));
            if (fileStat.ino !== 0) {
                if (seenInodes.has(fileStat.ino)) continue;
                seenInodes.add(fileStat.ino);
            }
            total += fileStat.size;
        } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
                throw error;
            }
            // File may be concurrently unlinked by consumer cleanup.
        }
    }
    return total;
}

async function resolveStoredPageArtifactPath(
    entryDir: string,
    pageNumber: number,
    logicalFileName: string,
) {
    const manifestPath = join(entryDir, 'checkpoint.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        completedPages: Record<string, {
            artifacts: Array<{
                fileName: string;
                storedFileName?: string;
            }>;
        }>;
    };
    const artifact = manifest.completedPages[String(pageNumber)]?.artifacts.find(
        entry => entry.fileName === logicalFileName,
    );
    if (artifact === undefined) {
        throw new Error(`Missing checkpoint artifact ${logicalFileName} for page ${String(pageNumber)}`);
    }
    return join(entryDir, 'artifacts', `page-${String(pageNumber)}`, artifact.storedFileName ?? artifact.fileName);
}

async function resolveStoredBatchPdfPath(entryDir: string, batchIndex: number) {
    const manifestPath = join(entryDir, 'checkpoint.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        completedBatches: Record<string, {pdfFileName: string | null}>;
    };
    const pdfFileName = manifest.completedBatches[String(batchIndex)]?.pdfFileName;
    if (pdfFileName === null || pdfFileName === undefined) {
        throw new Error(`Missing checkpoint batch PDF for batch ${String(batchIndex)}`);
    }
    return join(entryDir, 'artifacts', `batch-${String(batchIndex)}`, pdfFileName);
}

interface ITestManifestPage {
    sourcePageIndex: number;
    inputPath: string;
    analysisInputPath?: string;
    pageMetadataPath: string;
    options: {excluded: boolean};
    outputs: Array<{
        outputPath: string;
        metadataPath: string;
    }>;
}

async function createStreamingFixture(config: {
    pageCount: number;
    ppmBytes?: Buffer;
    rasterWidth?: number;
    rasterHeight?: number;
    useScratchDir?: boolean;
    useCheckpointDir?: boolean;
    streamingHandoff?: IScanCleanupStreamingHandoffLimits;
    availableScratchBytes?: number | null;
}) {
    const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-streaming-test-'));
    roots.push(root);
    const sourcePdfPath = join(root, 'source.pdf');
    const outputPdfPath = join(root, 'output.pdf');
    const scratchDir = config.useScratchDir === false ? undefined : join(root, 'scratch');
    const checkpointDir = config.useCheckpointDir ? join(root, 'checkpoints') : undefined;
    if (scratchDir !== undefined) {
        await mkdir(scratchDir, {recursive: true});
    }
    await writeFile(sourcePdfPath, '%PDF-1.7-streaming-source-bytes');

    const ppmPayload = config.ppmBytes ?? SMALL_PPM;
    const rasterWidth = config.rasterWidth ?? 1;
    const rasterHeight = config.rasterHeight ?? 1;
    const pageSizes = Array.from({length: config.pageCount}, (_, index) => pageGeometry(index + 1));

    const writeDefaultSidecarOutputs = async (
        manifest: {pages: ITestManifestPage[]},
        onProgress: Parameters<IRunScanCleanupPipelineDependencies['runSidecar']>[4],
        options: {
            spreadPages?: ReadonlySet<number>;
        } = {},
    ) => {
        for (const [
            index,
            page,
        ] of manifest.pages.entries()) {
            const sourcePage = page.sourcePageIndex + 1;
            const excluded = page.options.excluded;
            const isSpread = !excluded && (options.spreadPages?.has(sourcePage) ?? false);
            await writeFile(page.pageMetadataPath, JSON.stringify(pageMetadata({
                excluded,
                layoutClassification: isSpread ? 'two-page-spread' : 'single-uncut-page',
                outputCount: excluded ? 0 : isSpread ? 2 : 1,
            })));
            if (!excluded) {
                if (isSpread) {
                    await writeFile(page.outputs[0]!.outputPath, `cleaned-page-${String(sourcePage)}-left`);
                    await writeFile(page.outputs[0]!.metadataPath, JSON.stringify(outputMetadata('left')));
                    await writeFile(page.outputs[1]!.outputPath, `cleaned-page-${String(sourcePage)}-right`);
                    await writeFile(page.outputs[1]!.metadataPath, JSON.stringify(outputMetadata('right')));
                } else {
                    await writeFile(page.outputs[0]!.outputPath, `cleaned-page-${String(sourcePage)}-full`);
                    await writeFile(page.outputs[0]!.metadataPath, JSON.stringify(outputMetadata('full')));
                }
            }
            await onProgress({
                stage: 'page-complete',
                pageNumber: requirePageNumber(index + 1),
                completedPages: index + 1,
                totalPages: manifest.pages.length,
            });
        }
    };

    const dependencies: IRunScanCleanupPipelineDependencies = {
        getPageCount: vi.fn(async () => config.pageCount),
        getPageSizeStore: vi.fn(async () => createArrayBackedPdfPageSizeStore(pageSizes)),
        detectSourceDpi: vi.fn(async () => ({
            detected: true,
            documentDpi: 300,
            compactLayeredPageCount: 0,
            compactLayeredPageCountComplete: true,
            getPageRaster: () => ({
                dpi: 300,
                width: rasterWidth,
                height: rasterHeight,
            }),
        })),
        getAvailableScratchBytes: vi.fn(async () => config.availableScratchBytes ?? null),
        hashNativeBinary: vi.fn(async () => 'a'.repeat(64)),
        renderPage: vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, ppmPayload);
        }),
        runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            await writeDefaultSidecarOutputs(manifest, onProgress);
        }),
        runCommand: vi.fn(async (_binary, args) => {
            if (args[0] === 'annotation-index') {
                await writeFile(args[args.indexOf('--output') + 1]!, `${JSON.stringify({
                    format: 'evb-pdf-annotation-name-index',
                    schemaVersion: 1,
                    pageCount: config.pageCount,
                    chunkBytes: 4 * 1024 * 1024,
                })}\n`);
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            if (args[0] === 'ocr-text-visibility') {
                const pages = (await readFile(args[args.indexOf('--pages-file') + 1]!, 'utf8'))
                    .trim().split('\n').filter(Boolean).map(Number);
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: JSON.stringify({
                        format: 'evb-pdf-ocr-text-visibility',
                        schemaVersion: 3,
                        pages: pages.map(pageNumber => ({
                            pageNumber,
                            evbOcrLayer: false,
                            paintedText: false,
                            hiddenText: false,
                            uncertain: null,
                            unsupported: null,
                            evbOcrLines: null,
                        })),
                    }),
                };
            }
            if (args[0] === '--check') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                };
            }
            const outputIndex = args.indexOf('--output');
            const output = outputIndex >= 0 ? args[outputIndex + 1]! : args.at(-1)!;
            await writeFile(output, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        }),
        ...(config.streamingHandoff === undefined ? {} : {streamingHandoff: config.streamingHandoff}),
    };

    const workerPaths: IScanCleanupWorkerPaths = {
        qpdfBinary: '/qpdf',
        pdftoppmBinary: '/pdftoppm',
        pdfimagesBinary: '/pdfimages',
        scanCleanupBinary: '/scan-cleanup',
        pdfImageCombineBinary: '/pdf-image-combine',
        pdfPageOpsBinary: '/pdf-page-ops',
        tempDir: root,
        provenanceStampSupport: false,
        ...(scratchDir === undefined ? {} : {scratchDir}),
        ...(checkpointDir === undefined ? {} : {checkpointDir}),
    };

    return {
        root,
        sourcePdfPath,
        outputPdfPath,
        scratchDir,
        checkpointDir,
        dependencies,
        workerPaths,
        writeDefaultSidecarOutputs,
    };
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan-cleanup bounded streaming handoff and witness-bound checkpoints', () => {
    it('bounds producer ahead-of-consumer rasterization by page cap, overlaps work, and reclaims consumed PPMs', async () => {
        const pageCount = 16;
        const fixture = await createStreamingFixture({
            pageCount,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const scratchDir = fixture.scratchDir!;
        const startedRenderPages = new Set<number>();
        const activeOnDiskSnapshots: number[] = [];
        const chunkStartedPages: number[][] = [];
        let releaseFirstChunk!: () => void;
        let firstChunkEntered!: () => void;
        const firstChunkBlocked = new Promise<void>(resolve => {
            releaseFirstChunk = resolve;
        });
        const waitForFirstChunk = new Promise<void>(resolve => {
            firstChunkEntered = resolve;
        });
        let chunkCalls = 0;

        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            startedRenderPages.add(pageNumber);
            await writeFile(outputPath, SMALL_PPM);
            const residentInputs = (await listStagedSourceRasters(scratchDir))
                .filter(name => !name.includes('-analysis-'));
            activeOnDiskSnapshots.push(residentInputs.length);
        });

        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            chunkStartedPages.push(pages);
            const callIndex = chunkCalls;
            chunkCalls += 1;
            if (callIndex === 0) {
                firstChunkEntered();
                await firstChunkBlocked;
            } else {
                // Earlier chunk inputs must already have been unlinked before
                // later chunks run.
                for (const previousPage of chunkStartedPages[callIndex - 1]!) {
                    await expect(access(join(scratchDir, `source-${String(previousPage)}.ppm`))).rejects.toThrow();
                }
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        const abortRun = new AbortController();
        const conversionPromise = runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );

        let summary;
        try {
            await waitForFirstChunk;
            // Wait briefly for the producer to fill its allowed lookahead window
            // while chunk 0 is paused inside the sidecar.
            await vi.waitFor(() => {
                expect(startedRenderPages.size).toBe(4);
            });
            // Flush event-loop turns to verify the producer does NOT run past
            // the 4-page cap while chunk 0 is still active.
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect([...startedRenderPages].sort((left, right) => left - right)).toEqual([
                1,
                2,
                3,
                4,
            ]);
            expect(startedRenderPages.has(5)).toBe(false);

            releaseFirstChunk();
            summary = await conversionPromise;
        } finally {
            releaseFirstChunk();
            abortRun.abort();
            await conversionPromise.catch(() => undefined);
        }

        expect(summary).toMatchObject({
            inputPages: pageCount,
            outputPages: pageCount,
        });
        // Producer never held more than maxInFlightPages primary rasters on disk.
        expect(Math.max(...activeOnDiskSnapshots)).toBeLessThanOrEqual(4);
        expect(chunkStartedPages).toEqual([
            [1, 2],
            [3, 4],
            [5, 6],
            [7, 8],
            [9, 10],
            [11, 12],
            [13, 14],
            [15, 16],
        ]);
        // All staged source rasters are cleaned up once consumed.
        expect(await listStagedSourceRasters(scratchDir)).toEqual([]);
        expect(fixture.dependencies.renderPage).not.toHaveBeenCalled();
    });

    it('enforces byte and disk caps dynamically and preserves single-page liveness when one page exceeds the cap', async () => {
        // 100x100 RGB PPM is ~30 KiB per page; cap at 65 KiB so at most 2
        // pages can sit staged even though maxInFlightPages=8 and maxChunkPages=4.
        const largePpm = makePpm(100, 100);
        const fixture = await createStreamingFixture({
            pageCount: 8,
            ppmBytes: largePpm,
            rasterWidth: 100,
            rasterHeight: 100,
            streamingHandoff: {
                maxInFlightPages: 8,
                maxChunkPages: 4,
                maxInFlightBytes: 65_000,
            },
        });
        const scratchDir = fixture.scratchDir!;
        const observedDiskBytes: number[] = [];
        const chunkSizes: number[] = [];

        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, largePpm);
            observedDiskBytes.push(await measureStagedSourceBytes(scratchDir));
        });
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            chunkSizes.push(manifest.pages.length);
            observedDiskBytes.push(await measureStagedSourceBytes(scratchDir));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            {
                ...basePolicy,
                rasterConcurrency: 4,
            },
            () => undefined,
            fixture.dependencies,
        );

        expect(summary.outputPages).toBe(8);
        // Byte cap forced smaller chunks and prevented buffering all 8 pages.
        expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(2);
        // Peak resident bytes on disk remained bounded (at most 2 pages' rasters).
        expect(Math.max(...observedDiskBytes)).toBeLessThanOrEqual(largePpm.byteLength * 2 + 2_048);

        // Single-page liveness: cap smaller than a single page must still make
        // forward progress one page at a time without deadlocking.
        const singlePageCapFixture = await createStreamingFixture({
            pageCount: 3,
            ppmBytes: largePpm,
            rasterWidth: 100,
            rasterHeight: 100,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 4,
                maxInFlightBytes: 128,
            },
        });
        const singleCapChunks: number[] = [];
        singlePageCapFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            singleCapChunks.push(manifest.pages.length);
            await singlePageCapFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const singleCapSummary = await runScanCleanupConversion(
            {
                sourcePdfPath: singlePageCapFixture.sourcePdfPath,
                outputPdfPath: singlePageCapFixture.outputPdfPath,
                options: baseOptions,
            },
            singlePageCapFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            singlePageCapFixture.dependencies,
        );
        expect(singleCapSummary.outputPages).toBe(3);
        expect(singleCapChunks).toEqual([
            1,
            1,
            1,
        ]);

        // Disk-derived budget tightens automatically under low free scratch.
        const tightDiskBudget = resolveStreamingRasterHandoffBudget({
            availableScratchBytes: 540 * 1024 * 1024,
            rasterConcurrency: 4,
            totalPages: 500,
        });
        const ampleDiskBudget = resolveStreamingRasterHandoffBudget({
            availableScratchBytes: 400 * 1024 * 1024 * 1024,
            rasterConcurrency: 4,
            totalPages: 500,
        });
        expect(tightDiskBudget.maxInFlightBytes).toBeLessThan(ampleDiskBudget.maxInFlightBytes);
        expect(tightDiskBudget.maxInFlightBytes).toBe(28 * 1024 * 1024);
    });

    it('preserves exact page order, output integrity, and monotonic progress when producer finishes out of order', async () => {
        const pageCount = 12;
        const fixture = await createStreamingFixture({
            pageCount,
            streamingHandoff: {
                maxInFlightPages: 6,
                maxChunkPages: 3,
            },
        });
        const spreadPages = new Set([4]);
        const excludedPage = 7;
        const progressEvents: TScanCleanupProgress[] = [];
        const sidecarBatches: number[][] = [];
        let combineManifestTsv = '';

        // Hold each odd page until its paired even page completes its primary
        // render so producer completion is deterministically out of order.
        const evenPageRendered = new Map<number, {
            promise: Promise<void>;
            resolve: () => void;
        }>();
        for (let page = 2; page <= pageCount; page += 2) {
            let resolve!: () => void;
            const promise = new Promise<void>(done => {
                resolve = done;
            });
            evenPageRendered.set(page, {
                promise,
                resolve,
            });
        }
        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            if (pageNumber % 2 === 1 && !outputPath.includes('-analysis-')) {
                await evenPageRendered.get(pageNumber + 1)?.promise;
            }
            await writeFile(outputPath, SMALL_PPM);
            if (pageNumber % 2 === 0 && !outputPath.includes('-analysis-')) {
                evenPageRendered.get(pageNumber)?.resolve();
            }
        });
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            sidecarBatches.push(manifest.pages.map(page => page.sourcePageIndex + 1));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress, {spreadPages});
        });
        const baseRunCommand = fixture.dependencies.runCommand;
        fixture.dependencies.runCommand = vi.fn(async (binary, args, commandOptions) => {
            const manifestFlagIndex = args.indexOf('--compact-manifest');
            if (manifestFlagIndex >= 0) {
                combineManifestTsv = await readFile(args[manifestFlagIndex + 1]!, 'utf8');
            }
            return baseRunCommand(binary, args, commandOptions);
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...baseOptions,
                    pageOverrides: {
                        [String(excludedPage)]: {
                            rotationDegrees: 0,
                            layoutOverride: 'auto',
                            excluded: true,
                            manualSplit: null,
                        },
                    },
                },
            },
            fixture.workerPaths,
            new AbortController().signal,
            progress => progressEvents.push(progress),
            {
                ...basePolicy,
                rasterConcurrency: 3,
            },
            () => undefined,
            fixture.dependencies,
        );

        // 12 input pages - 1 excluded + 1 spread split = 12 output pages.
        expect(summary).toMatchObject({
            inputPages: 12,
            outputPages: 12,
            spreadsSplit: 1,
            excludedPages: 1,
        });
        expect(sidecarBatches).toEqual([
            [1, 2, 3],
            [4, 5, 6],
            [7, 8, 9],
            [10, 11, 12],
        ]);
        const combinedOutputFiles = combineManifestTsv.trim().split('\n').map(line => line.split('\t').at(-1)!);
        expect(combinedOutputFiles.map(path => path.slice(path.lastIndexOf('/') + 1))).toEqual([
            'clean-1-0.png',
            'clean-2-0.png',
            'clean-3-0.png',
            'clean-4-0.png',
            'clean-4-1.png',
            'clean-5-0.png',
            'clean-6-0.png',
            'clean-8-0.png',
            'clean-9-0.png',
            'clean-10-0.png',
            'clean-11-0.png',
            'clean-12-0.png',
        ]);
        // Every output payload matches its exact page and half.
        const expectedPayloads = [
            'cleaned-page-1-full',
            'cleaned-page-2-full',
            'cleaned-page-3-full',
            'cleaned-page-4-left',
            'cleaned-page-4-right',
            'cleaned-page-5-full',
            'cleaned-page-6-full',
            'cleaned-page-8-full',
            'cleaned-page-9-full',
            'cleaned-page-10-full',
            'cleaned-page-11-full',
            'cleaned-page-12-full',
        ];
        expect(await Promise.all(combinedOutputFiles.map(file => readFile(file, 'utf8')))).toEqual(expectedPayloads);

        // Progress never rewinds from rendering back to rasterizing and percent is monotonic.
        let sawRendering = false;
        let lastPercent = 0;
        for (const event of progressEvents) {
            expect(event.percent).toBeGreaterThanOrEqual(lastPercent);
            lastPercent = event.percent;
            expect(event.completedUnits).toBeLessThanOrEqual(event.totalUnits);
            if (event.stage === 'rendering') {
                sawRendering = true;
            }
            if (sawRendering) {
                expect(event.stage).not.toBe('rasterizing');
            }
        }
        expect(sawRendering).toBe(true);
        expect(progressEvents.at(-1)).toMatchObject({
            stage: 'handoff',
            completedUnits: 12,
            totalUnits: 12,
            percent: 100,
        });
    });

    it('completes and aborts cleanly under a single-slot JobBroker with zero deadlock and zero leaked temp files', async () => {
        const singleSlotResources = {
            cpuTokens: 1,
            estimatedResidentBytes: 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 1,
        };
        const broker = new JobBroker(singleSlotResources);

        // 1. Full multi-chunk streaming conversion under a 1-slot broker must not deadlock.
        const fixture = await createStreamingFixture({
            pageCount: 10,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath, _dpi, _env, signal) => {
            await broker.run({
                ownerId: 'scan-cleanup-owner',
                kind: 'scan-cleanup-op',
                priority: 'user',
                perOwnerLimit: 1,
                resources: singleSlotResources,
                ...(signal === undefined ? {} : {signal}),
            }, async () => {
                await new Promise<void>(resolve => setImmediate(resolve));
                await writeFile(outputPath, SMALL_PPM);
            });
        });
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            await broker.run({
                ownerId: 'scan-cleanup-owner',
                kind: 'scan-cleanup-op',
                priority: 'user',
                perOwnerLimit: 1,
                resources: singleSlotResources,
                signal,
            }, async () => {
                await new Promise<void>(resolve => setImmediate(resolve));
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
                await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
            });
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );
        expect(summary.outputPages).toBe(10);
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });

        // 2. Cancellation mid-stream under the same 1-slot broker aborts
        // promptly without deadlock, releases all broker leases, and leaves
        // zero temp/scratch files behind.
        const cancelFixture = await createStreamingFixture({
            pageCount: 10,
            useScratchDir: false,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortController = new AbortController();
        let sidecarChunkCount = 0;

        cancelFixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath, _dpi, _env, signal) => {
            await broker.run({
                ownerId: 'scan-cleanup-cancel-owner',
                kind: 'scan-cleanup-op',
                priority: 'user',
                perOwnerLimit: 1,
                resources: singleSlotResources,
                ...(signal === undefined ? {} : {signal}),
            }, async () => {
                signal?.throwIfAborted();
                await writeFile(outputPath, SMALL_PPM);
            });
        });
        cancelFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            await broker.run({
                ownerId: 'scan-cleanup-cancel-owner',
                kind: 'scan-cleanup-op',
                priority: 'user',
                perOwnerLimit: 1,
                resources: singleSlotResources,
                signal,
            }, async () => {
                sidecarChunkCount += 1;
                if (sidecarChunkCount === 2) {
                    abortController.abort(new DOMException('User canceled conversion', 'AbortError'));
                    signal.throwIfAborted();
                }
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
                await cancelFixture.writeDefaultSidecarOutputs(manifest, onProgress);
            });
        });

        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: cancelFixture.sourcePdfPath,
                outputPdfPath: cancelFixture.outputPdfPath,
                options: baseOptions,
            },
            cancelFixture.workerPaths,
            abortController.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            cancelFixture.dependencies,
        )).rejects.toThrow('User canceled conversion');

        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
        expect(existsSync(cancelFixture.outputPdfPath)).toBe(false);
        expect(await readdir(cancelFixture.root)).toEqual(['source.pdf']);
    });

    it('resumes completed pages from witness-bound checkpoints when source and options match, and cleans up on completion', async () => {
        const fixture = await createStreamingFixture({
            pageCount: 8,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortRun1 = new AbortController();
        const run1RenderedPages: number[] = [];
        const run1SidecarPages: number[] = [];
        let run1Chunks = 0;

        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            run1RenderedPages.push(pageNumber);
            await writeFile(outputPath, SMALL_PPM);
        });
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            run1Chunks += 1;
            if (run1Chunks === 3) {
                abortRun1.abort(new DOMException('Interrupted after chunk 2', 'AbortError'));
                signal.throwIfAborted();
            }
            for (const page of manifest.pages) {
                run1SidecarPages.push(page.sourcePageIndex + 1);
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Interrupted after chunk 2');

        expect(run1SidecarPages).toEqual([
            1,
            2,
            3,
            4,
        ]);
        expect(existsSync(fixture.outputPdfPath)).toBe(false);
        // Checkpoint persisted in checkpointDir while scratch was cleaned up.
        const checkpointEntriesAfterInterrupt = await readdir(fixture.checkpointDir!);
        expect(checkpointEntriesAfterInterrupt).toHaveLength(1);

        // Run 2 with identical source bytes and identical options must resume
        // pages 1..4 from checkpoint without re-rasterizing or re-running sidecar.
        const run2RenderedPages: number[] = [];
        const run2SidecarPages: number[] = [];
        let run2CombineManifest = '';
        fixture.dependencies.renderPagePpm = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            run2RenderedPages.push(pageNumber);
            await writeFile(outputPath, SMALL_PPM);
        });
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            for (const page of manifest.pages) {
                run2SidecarPages.push(page.sourcePageIndex + 1);
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const baseRunCommand = fixture.dependencies.runCommand;
        fixture.dependencies.runCommand = vi.fn(async (binary, args, commandOptions) => {
            const manifestFlagIndex = args.indexOf('--compact-manifest');
            if (manifestFlagIndex >= 0) {
                run2CombineManifest = await readFile(args[manifestFlagIndex + 1]!, 'utf8');
            }
            return baseRunCommand(binary, args, commandOptions);
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );

        expect(summary).toMatchObject({
            inputPages: 8,
            outputPages: 8,
        });
        expect(run2SidecarPages).toEqual([
            5,
            6,
            7,
            8,
        ]);
        expect([...new Set(run2RenderedPages)].sort((left, right) => left - right)).toEqual([
            5,
            6,
            7,
            8,
        ]);
        expect(run2CombineManifest.trim().split('\n')).toHaveLength(8);
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('%PDF-1.7');
        // Completed checkpoint is removed cleanly after publication.
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);
    });

    it.each([
        'source bytes changed',
        'options changed',
    ] as const)('invalidates stale checkpoint artifacts and cleans up temp files when %s', async scenario => {
        const fixture = await createStreamingFixture({
            pageCount: 6,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortRun1 = new AbortController();
        let run1Chunks = 0;

        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            run1Chunks += 1;
            if (run1Chunks === 2) {
                abortRun1.abort(new DOMException('Interrupted mid-conversion', 'AbortError'));
                signal.throwIfAborted();
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Interrupted mid-conversion');

        const staleEntries = await readdir(fixture.checkpointDir!);
        expect(staleEntries).toHaveLength(1);
        const staleEntryName = staleEntries[0]!;
        // Plant an orphan temporary file in checkpointDir to verify temp cleanup too.
        await writeFile(join(fixture.checkpointDir!, 'orphan.tmp'), 'stale');

        if (scenario === 'source bytes changed') {
            await writeFile(fixture.sourcePdfPath, '%PDF-1.7-modified-source-bytes');
        }
        const run2Options: IScanCleanupOptions = scenario === 'options changed'
            ? {
                ...baseOptions,
                crop: true,
            }
            : baseOptions;

        const run2SidecarPages: number[] = [];
        let observedStaleEntryStillPresent = false;
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const currentEntries = await readdir(fixture.checkpointDir!);
            if (currentEntries.includes(staleEntryName) || currentEntries.includes('orphan.tmp')) {
                observedStaleEntryStillPresent = true;
            }
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            for (const page of manifest.pages) {
                run2SidecarPages.push(page.sourcePageIndex + 1);
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: run2Options,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );

        expect(observedStaleEntryStillPresent).toBe(false);
        expect(summary.outputPages).toBe(6);
        // Every page was re-processed because the stale witness was invalidated.
        expect(run2SidecarPages).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);
    });

    it('re-runs a page whose checkpoint artifact was corrupted while resuming valid pages', async () => {
        const fixture = await createStreamingFixture({
            pageCount: 6,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortRun1 = new AbortController();
        let run1Chunks = 0;

        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            run1Chunks += 1;
            if (run1Chunks === 3) {
                abortRun1.abort(new DOMException('Interrupted before final chunk', 'AbortError'));
                signal.throwIfAborted();
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Interrupted before final chunk');

        // Corrupt page 2's persisted output artifact inside the checkpoint.
        const [entryName] = await readdir(fixture.checkpointDir!);
        const page2OutputPath = await resolveStoredPageArtifactPath(
            join(fixture.checkpointDir!, entryName!),
            2,
            'clean-2-0.png',
        );
        await rm(page2OutputPath, {force: true});

        const run2SidecarPages: number[] = [];
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            for (const page of manifest.pages) {
                run2SidecarPages.push(page.sourcePageIndex + 1);
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );

        expect(summary.outputPages).toBe(6);
        // Pages 1, 3, 4 resumed cleanly; missing page 2 plus uncompleted pages 5 and 6 ran.
        expect(run2SidecarPages).toEqual([
            2,
            5,
            6,
        ]);
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);
    });

    it('resumes completed streaming batches in xlarge conversions and invalidates when options change', async () => {
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);
        const fixture = await createStreamingFixture({
            pageCount: 3,
            useScratchDir: false,
            useCheckpointDir: true,
        });
        const abortRun1 = new AbortController();
        const run1SidecarPages: number[] = [];

        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            if (pages.includes(3)) {
                abortRun1.abort(new DOMException('Interrupted during batch 1', 'AbortError'));
                signal.throwIfAborted();
            }
            run1SidecarPages.push(...pages);
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Interrupted during batch 1');

        expect(run1SidecarPages).toEqual([
            1,
            2,
        ]);

        // Resume with matching source + options: batch 0 is skipped completely.
        const run2SidecarPages: number[] = [];
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            run2SidecarPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });

        const resumedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );

        expect(resumedSummary).toMatchObject({
            inputPages: 3,
            outputPages: 3,
        });
        expect(run2SidecarPages).toEqual([3]);
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);

        // Interrupt a fresh xlarge run after batch 0, then change options:
        // stale batch 0 checkpoint must be invalidated and all 3 pages re-run.
        const abortRun3 = new AbortController();
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            if (pages.includes(3)) {
                abortRun3.abort(new DOMException('Interrupted before options change', 'AbortError'));
                signal.throwIfAborted();
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun3.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Interrupted before options change');
        expect(await readdir(fixture.checkpointDir!)).toHaveLength(1);

        const run4SidecarPages: number[] = [];
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            run4SidecarPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const invalidatedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );
        expect(invalidatedSummary).toMatchObject({
            inputPages: 3,
            outputPages: 3,
        });
        expect(run4SidecarPages).toEqual([
            1,
            2,
            3,
        ]);
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);
    });

    it('preserves a late consumer unproven-termination error and retains staged inputs when masked by an earlier producer failure', async () => {
        const consumerEntered = Promise.withResolvers<void>();
        const releaseConsumer = Promise.withResolvers<void>();
        const producerFailed = Promise.withResolvers<void>();
        const cleanedItems: number[] = [];

        const runPromise = runBoundedRasterProducerConsumer<number, number>({
            items: [1, 2, 3, 4],
            budget: {
                producerConcurrency: 2,
                maxChunkPages: 1,
                maxInFlightPages: 3,
                maxInFlightBytes: 1024 * 1024,
            },
            signal: new AbortController().signal,
            estimateItemBytes: () => 1024,
            produce: async (item) => {
                if (item === 2) {
                    await consumerEntered.promise;
                    producerFailed.resolve();
                    throw new Error('producer pdftoppm failed on page 2');
                }
                return {
                    staged: item,
                    actualBytes: 1024,
                };
            },
            consumeChunk: async (chunk, _chunkIndex, operationSignal) => {
                expect(chunk).toEqual([1]);
                consumerEntered.resolve();
                await producerFailed.promise;
                await releaseConsumer.promise;
                expect(operationSignal.aborted).toBe(true);
                throw markUnprovenNativeTermination(
                    new Error('evb-scan-cleanup did not exit'),
                    'evb-scan-cleanup process tree (pid=98765) was not proven dead; its inputs may still be open',
                );
            },
            cleanupStaged: async staged => {
                cleanedItems.push(...staged);
            },
        });

        await producerFailed.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        releaseConsumer.resolve();

        let caught: unknown;
        try {
            await runPromise;
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeDefined();
        expect(getUnprovenNativeTerminationDetail(caught)).toContain('pid=98765');
        // Active chunk and any ready staged inputs must be retained when
        // termination was not proven.
        expect(cleanedItems).toEqual([]);
    });

    it('enforces conservative pre-write byte reservation for PNG fallback and equal-DPI analysis copies', async () => {
        // 100x100 RGB @ 150 DPI => raw RGB = 30,000 bytes; primary + analysis
        // conservative pre-write reservation = 60,000 bytes per page (no 0.2x
        // PNG discount and includes analysis copy even at equal DPI).
        // Set maxInFlightBytes = 80,000 so page 2 cannot be admitted concurrently
        // with page 1 BEFORE page 1 writes and reconciles actual size.
        const fixture = await createStreamingFixture({
            pageCount: 3,
            rasterWidth: 100,
            rasterHeight: 100,
            // Force PNG fallback via low available scratch bytes while still
            // letting the conversion proceed.
            availableScratchBytes: 512 * 1024 * 1024 + 10_000,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
                maxInFlightBytes: 80_000,
            },
        });
        const page1Started = Promise.withResolvers<void>();
        const releasePage1 = Promise.withResolvers<void>();
        const startedPagesBeforePage1Finish = new Set<number>();
        let page1Finished = false;

        // Write valid 100x100 PNGs (~400 B each) so after page 1 reconciles,
        // page 2 fits inside maxInFlightBytes.
        const png100x100 = Buffer.from(encodePng({
            width: 100,
            height: 100,
            data: new Uint8Array(100 * 100 * 3),
            channels: 3,
            depth: 8,
        }));
        fixture.dependencies.detectSourceDpi = vi.fn(async () => ({
            detected: true,
            documentDpi: 150,
            compactLayeredPageCount: 0,
            compactLayeredPageCountComplete: true,
            getPageRaster: () => ({
                dpi: 150,
                width: 100,
                height: 100,
            }),
        }));
        fixture.dependencies.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            if (!page1Finished) {
                startedPagesBeforePage1Finish.add(pageNumber);
            }
            if (pageNumber === 1) {
                page1Started.resolve();
                await releasePage1.promise;
            }
            await writeFile(outputPath, png100x100);
            if (pageNumber === 1) {
                page1Finished = true;
            }
        });

        const abortRun = new AbortController();
        const conversionPromise = runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun.signal,
            () => undefined,
            {
                ...basePolicy,
                rasterConcurrency: 3,
            },
            () => undefined,
            fixture.dependencies,
        );

        let summary;
        try {
            await page1Started.promise;
            await new Promise<void>(resolve => setImmediate(resolve));
            await new Promise<void>(resolve => setImmediate(resolve));
            // Because page 1 conservatively reserved 60,000 bytes (primary +
            // analysis without a PNG discount), page 2 (another 60,000 bytes)
            // must NOT start in parallel under an 80,000-byte cap.
            expect([...startedPagesBeforePage1Finish]).toEqual([1]);

            releasePage1.resolve();
            summary = await conversionPromise;
        } finally {
            releasePage1.resolve();
            abortRun.abort();
            await conversionPromise.catch(() => undefined);
        }
        expect(summary.outputPages).toBe(3);
        expect(fixture.dependencies.renderPage).toHaveBeenCalledTimes(3);
    });

    it('aggregates multiple independent producer failures alongside a late consumer unproven-termination error', async () => {
        const consumerEntered = Promise.withResolvers<void>();
        const producer2Entered = Promise.withResolvers<void>();
        const producer3Entered = Promise.withResolvers<void>();
        const releaseConsumer = Promise.withResolvers<void>();
        const cleanedItems: number[] = [];

        const runPromise = runBoundedRasterProducerConsumer<number, number>({
            items: [1, 2, 3, 4],
            budget: {
                producerConcurrency: 2,
                maxChunkPages: 1,
                maxInFlightPages: 4,
                maxInFlightBytes: 1024 * 1024,
            },
            signal: new AbortController().signal,
            estimateItemBytes: () => 1024,
            produce: async (item) => {
                if (item === 2) {
                    await consumerEntered.promise;
                    producer2Entered.resolve();
                    await producer3Entered.promise;
                    throw new Error('producer failure on page 2');
                }
                if (item === 3) {
                    await producer2Entered.promise;
                    producer3Entered.resolve();
                    throw new Error('independent producer failure on page 3');
                }
                return {
                    staged: item,
                    actualBytes: 1024,
                };
            },
            consumeChunk: async (chunk, _chunkIndex, operationSignal) => {
                expect(chunk).toEqual([1]);
                consumerEntered.resolve();
                await producer3Entered.promise;
                await releaseConsumer.promise;
                expect(operationSignal.aborted).toBe(true);
                throw markUnprovenNativeTermination(
                    new Error('evb-scan-cleanup consumer unproven termination'),
                    'evb-scan-cleanup process tree (pid=54321) was not proven dead; inputs retained',
                );
            },
            cleanupStaged: async staged => {
                cleanedItems.push(...staged);
            },
        });

        await producer3Entered.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        releaseConsumer.resolve();

        let caught: unknown;
        try {
            await runPromise;
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(AggregateError);
        const aggregate = caught as AggregateError;
        const messages = aggregate.errors.map(error => (error instanceof Error ? error.message : String(error)));
        expect(messages).toContain('producer failure on page 2');
        expect(messages).toContain('independent producer failure on page 3');
        expect(messages).toContain('evb-scan-cleanup consumer unproven termination');
        expect(getUnprovenNativeTerminationDetail(caught)).toContain('pid=54321');
        expect(cleanedItems).toEqual([]);
    });

    it('serializes concurrent checkpoint commits without lost updates and preserves active entries against competing opens', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-ckpt-concurrency-'));
        roots.push(root);
        const checkpointDir = join(root, 'checkpoints');
        const scratchA = join(root, 'scratch-a');
        const scratchB = join(root, 'scratch-b');
        const scratchRestore = join(root, 'scratch-restore');
        await Promise.all([
            mkdir(scratchA, {recursive: true}),
            mkdir(scratchB, {recursive: true}),
            mkdir(scratchRestore, {recursive: true}),
        ]);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-concurrent');

        const sourceSha256 = createHash('sha256').update('%PDF-1.7-concurrent').digest('hex');
        const witnessA = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-a.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1, 2],
            documentPageCount: 2,
            documentCanvas: null,
            losslessRun: false,
        });
        const witnessDifferentOptions = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-b.pdf'),
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            resolvedOptions: {
                ...baseOptions,
                crop: true,
            },
            pageScope: [1, 2],
            documentPageCount: 2,
            documentCanvas: null,
            losslessRun: false,
        });
        const planSignature = computeScanCleanupRenderPlanSignature({
            documentCanvas: null,
            rasterFormat: 'ppm',
            pages: [],
        });

        const handleA = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness: witnessA,
            documentPageCount: 2,
            mode: 'batch',
            log: () => undefined,
        });
        const handleB = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness: witnessA,
            documentPageCount: 2,
            mode: 'batch',
            log: () => undefined,
        });

        // Full 64-hex witness entry name prevents prefix collisions.
        expect(handleA.entryDir.endsWith(`entry-${witnessA.witnessId}`)).toBe(true);

        // Competing changed-options open for the same sourcePdfPath must NOT
        // delete the actively leased checkpoint entry.
        const handleCompeting = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness: witnessDifferentOptions,
            documentPageCount: 2,
            mode: 'batch',
            log: () => undefined,
        });
        expect(existsSync(handleA.entryDir)).toBe(true);

        const writePageScratch = async (dir: string, pageNumber: number) => {
            const pageMetaPath = join(dir, `clean-${String(pageNumber)}-page.json`);
            const outMetaPath = join(dir, `clean-${String(pageNumber)}-0.json`);
            const outPngPath = join(dir, `clean-${String(pageNumber)}-0.png`);
            await writeFile(pageMetaPath, JSON.stringify(pageMetadata()));
            await writeFile(outMetaPath, JSON.stringify(outputMetadata()));
            await writeFile(outPngPath, PNG);
            return [
                {
                    scratchPath: pageMetaPath,
                    fileName: `clean-${String(pageNumber)}-page.json`,
                },
                {
                    scratchPath: outMetaPath,
                    fileName: `clean-${String(pageNumber)}-0.json`,
                },
                {
                    scratchPath: outPngPath,
                    fileName: `clean-${String(pageNumber)}-0.png`,
                },
            ];
        };

        const [
            artifacts1,
            artifacts2,
        ] = await Promise.all([
            writePageScratch(scratchA, 1),
            writePageScratch(scratchB, 2),
        ]);

        // Concurrent commits from two handles must merge cleanly without losing either page.
        await Promise.all([
            handleA.commitCompletedPages([{
                pageNumber: 1,
                artifacts: artifacts1,
            }], planSignature),
            handleB.commitCompletedPages([{
                pageNumber: 2,
                artifacts: artifacts2,
            }], planSignature),
        ]);
        await Promise.all([
            handleA.close(),
            handleB.close(),
            handleCompeting.close(),
        ]);

        const verifyHandle = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness: witnessA,
            documentPageCount: 2,
            mode: 'batch',
            log: () => undefined,
        });
        const restored = await verifyHandle.restoreCompletedPages(scratchRestore, [1, 2], planSignature);
        expect([...restored].sort((left, right) => left - right)).toEqual([1, 2]);
        await verifyHandle.complete();
    });

    it('invalidates checkpoints when caller provenance.sourceSha256 is spoofed, native tool identity changes, or detection-store recommendations change', async () => {
        // 1. Spoofed provenance.sourceSha256 must never bypass on-disk hashing.
        const spoofFixture = await createStreamingFixture({
            pageCount: 4,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const originalSourceDigest = createHash('sha256')
            .update(await readFile(spoofFixture.sourcePdfPath))
            .digest('hex');
        const abort1 = new AbortController();
        let chunks1 = 0;
        spoofFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, sig, _log, onProgress) => {
            chunks1 += 1;
            if (chunks1 === 2) {
                abort1.abort(new DOMException('Stop after chunk 0', 'AbortError'));
                sig.throwIfAborted();
            }
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            await spoofFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: spoofFixture.sourcePdfPath,
                outputPdfPath: spoofFixture.outputPdfPath,
                options: baseOptions,
                provenance: {
                    sourceSha256: originalSourceDigest,
                    nativeBinarySha256s: {},
                },
            },
            spoofFixture.workerPaths,
            abort1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            spoofFixture.dependencies,
        )).rejects.toThrow('Stop after chunk 0');

        // Mutate the on-disk PDF while still passing the stale provenance digest.
        await writeFile(spoofFixture.sourcePdfPath, '%PDF-1.7-mutated-on-disk');
        const spoofRun2Pages: number[] = [];
        spoofFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            spoofRun2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await spoofFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await runScanCleanupConversion(
            {
                sourcePdfPath: spoofFixture.sourcePdfPath,
                outputPdfPath: spoofFixture.outputPdfPath,
                options: baseOptions,
                provenance: {
                    sourceSha256: originalSourceDigest,
                    nativeBinarySha256s: {},
                },
            },
            spoofFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            spoofFixture.dependencies,
        );
        expect(spoofRun2Pages).toEqual([1, 2, 3, 4]);

        // 2. Native tool identity change invalidates checkpoint.
        const toolFixture = await createStreamingFixture({
            pageCount: 4,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortTool = new AbortController();
        let toolChunks = 0;
        toolFixture.dependencies.hashNativeBinary = vi.fn(async () => '1'.repeat(64));
        toolFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, sig, _log, onProgress) => {
            toolChunks += 1;
            if (toolChunks === 2) {
                abortTool.abort(new DOMException('Stop tool run', 'AbortError'));
                sig.throwIfAborted();
            }
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            await toolFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: toolFixture.sourcePdfPath,
                outputPdfPath: toolFixture.outputPdfPath,
                options: baseOptions,
            },
            toolFixture.workerPaths,
            abortTool.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            toolFixture.dependencies,
        )).rejects.toThrow('Stop tool run');

        toolFixture.dependencies.hashNativeBinary = vi.fn(async () => '2'.repeat(64));
        const toolRun2Pages: number[] = [];
        toolFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            toolRun2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await toolFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await runScanCleanupConversion(
            {
                sourcePdfPath: toolFixture.sourcePdfPath,
                outputPdfPath: toolFixture.outputPdfPath,
                options: baseOptions,
            },
            toolFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            toolFixture.dependencies,
        );
        expect(toolRun2Pages).toEqual([1, 2, 3, 4]);

        // 3. Detection-store recommendation change invalidates checkpoint.
        const detectFixture = await createStreamingFixture({
            pageCount: 4,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const makeDetectionStore = async (recommendedMode: 'bw' | 'grayscale') => {
            const store = await createFileBackedScanCleanupDetectionResultStore({
                rootDir: detectFixture.root,
                pageCount: 4,
            });
            for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
                await store.append({
                    pageNumber: requirePageNumber(pageNumber),
                    classification: 'single-uncut-page',
                    confidence: 0.99,
                    cutterXPx: null,
                    tier1Verdict: 'single-uncut-page',
                    reconciled: false,
                    clusterAgreement: 1,
                    documentPrior: null,
                    recommendedOutputMode: recommendedMode,
                    recommendedOutputModeConfidence: 0.99,
                    recommendedOutputModeReason: 'bimodal-text',
                });
            }
            return store;
        };
        const autoOptions: IScanCleanupOptions = {
            ...baseOptions,
            outputMode: 'auto',
        };
        const abortDetect = new AbortController();
        let detectChunks = 0;
        detectFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, sig, _log, onProgress) => {
            detectChunks += 1;
            if (detectChunks === 2) {
                abortDetect.abort(new DOMException('Stop detect run', 'AbortError'));
                sig.throwIfAborted();
            }
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            await detectFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const storeRun1 = await makeDetectionStore('bw');
        try {
            await expect(runScanCleanupConversion(
                {
                    sourcePdfPath: detectFixture.sourcePdfPath,
                    outputPdfPath: detectFixture.outputPdfPath,
                    options: autoOptions,
                    detectionResultStore: storeRun1,
                },
                detectFixture.workerPaths,
                abortDetect.signal,
                () => undefined,
                basePolicy,
                () => undefined,
                detectFixture.dependencies,
            )).rejects.toThrow('Stop detect run');
        } finally {
            await storeRun1.close();
        }

        const storeRun2 = await makeDetectionStore('grayscale');
        try {
            const detectRun2Pages: number[] = [];
            detectFixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, _sig, _log, onProgress) => {
                const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
                detectRun2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
                await detectFixture.writeDefaultSidecarOutputs(manifest, onProgress);
            });
            await runScanCleanupConversion(
                {
                    sourcePdfPath: detectFixture.sourcePdfPath,
                    outputPdfPath: detectFixture.outputPdfPath,
                    options: autoOptions,
                    detectionResultStore: storeRun2,
                },
                detectFixture.workerPaths,
                new AbortController().signal,
                () => undefined,
                basePolicy,
                () => undefined,
                detectFixture.dependencies,
            );
            expect(detectRun2Pages).toEqual([1, 2, 3, 4]);
        } finally {
            await storeRun2.close();
        }
    });

    it('detects same-size byte corruption, missing required output artifacts, and malformed batch checkpoint state', async () => {
        const fixture = await createStreamingFixture({
            pageCount: 6,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortRun1 = new AbortController();
        let chunks1 = 0;
        fixture.dependencies.runSidecar = vi.fn(async (_binary, manifestPath, sig, _log, onProgress) => {
            chunks1 += 1;
            if (chunks1 === 3) {
                abortRun1.abort(new DOMException('Stop before chunk 3', 'AbortError'));
                sig.throwIfAborted();
            }
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: ITestManifestPage[]};
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Stop before chunk 3');

        const [entryName] = await readdir(fixture.checkpointDir!);
        const entryDir = join(fixture.checkpointDir!, entryName!);

        // 1. Same-size byte corruption on page 2's output raster.
        const page2PngPath = await resolveStoredPageArtifactPath(entryDir, 2, 'clean-2-0.png');
        const originalPage2Bytes = await readFile(page2PngPath);
        const flipped = Buffer.from(originalPage2Bytes);
        flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
        expect(flipped.byteLength).toBe(originalPage2Bytes.byteLength);
        await writeFile(page2PngPath, flipped);

        // 2. Missing required output raster on page 3 (even removed from the
        // manifest's artifact list so only metadata completeness catches it).
        const page3PngPath = await resolveStoredPageArtifactPath(entryDir, 3, 'clean-3-0.png');
        await rm(page3PngPath, {force: true});
        const manifestPath = join(entryDir, 'checkpoint.json');
        const manifestObj = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            completedPages: Record<string, {artifacts: Array<{fileName: string}>}>;
        };
        manifestObj.completedPages['3']!.artifacts = manifestObj.completedPages['3']!.artifacts.filter(
            artifact => artifact.fileName !== 'clean-3-0.png',
        );
        await writeFile(manifestPath, `${JSON.stringify(manifestObj, null, 2)}\n`);

        const run2Pages: number[] = [];
        fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            run2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const summary = await runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: baseOptions,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );
        expect(summary.outputPages).toBe(6);
        // Pages 1 and 4 resumed; corrupted page 2, incomplete page 3, and unrun pages 5, 6 executed.
        expect(run2Pages).toEqual([2, 3, 5, 6]);

        // 3. Malformed batch state JSON (valid digest, invalid summary schema)
        // must be rejected as a cache miss and recomputed cleanly.
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);
        const batchFixture = await createStreamingFixture({
            pageCount: 3,
            useScratchDir: false,
            useCheckpointDir: true,
        });
        const abortBatch = new AbortController();
        batchFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            if (pages.includes(3)) {
                abortBatch.abort(new DOMException('Stop before batch 1', 'AbortError'));
                sig.throwIfAborted();
            }
            await batchFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: batchFixture.sourcePdfPath,
                outputPdfPath: batchFixture.outputPdfPath,
                options: baseOptions,
            },
            batchFixture.workerPaths,
            abortBatch.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            batchFixture.dependencies,
        )).rejects.toThrow('Stop before batch 1');

        const [batchEntryName] = await readdir(batchFixture.checkpointDir!);
        const batchEntryDir = join(batchFixture.checkpointDir!, batchEntryName!);
        const batchManifestPath = join(batchEntryDir, 'checkpoint.json');
        const batchManifest = JSON.parse(await readFile(batchManifestPath, 'utf8')) as {
            completedBatches: Record<string, {
                stateFileName: string;
                stateSizeBytes: number;
                stateSha256: string;
            }>;
        };
        const batch0Record = batchManifest.completedBatches['0']!;
        const batch0StatePath = join(batchEntryDir, 'artifacts', 'batch-0', batch0Record.stateFileName);
        const batch0State = JSON.parse(await readFile(batch0StatePath, 'utf8')) as {
            summary: Record<string, unknown>;
        };
        batch0State.summary.outputPages = 'corrupt-not-a-number';
        const malformedText = `${JSON.stringify(batch0State, null, 2)}\n`;
        await writeFile(batch0StatePath, malformedText);
        batch0Record.stateSizeBytes = Buffer.byteLength(malformedText, 'utf8');
        batch0Record.stateSha256 = createHash('sha256').update(malformedText).digest('hex');
        await writeFile(batchManifestPath, `${JSON.stringify(batchManifest, null, 2)}\n`);

        const batchRun2Pages: number[] = [];
        batchFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            batchRun2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await batchFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const repairedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: batchFixture.sourcePdfPath,
                outputPdfPath: batchFixture.outputPdfPath,
                options: baseOptions,
            },
            batchFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            batchFixture.dependencies,
        );
        expect(repairedSummary.outputPages).toBe(3);
        expect(batchRun2Pages).toEqual([1, 2, 3]);
    });

    it('rejects symlinked entry, artifacts, page, and leaf paths without traversing outside checkpointDir', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-ckpt-symlink-'));
        roots.push(root);
        const outsideDir = join(root, 'outside');
        const sentinelPath = join(outsideDir, 'sentinel.txt');
        await mkdir(outsideDir, {recursive: true});
        await writeFile(sentinelPath, 'outside-secret-payload');

        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-symlink');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-symlink').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const planSignature = computeScanCleanupRenderPlanSignature({
            documentCanvas: null,
            rasterFormat: 'ppm',
            pages: [],
        });

        // Case 1: Symlinked entry directory.
        const ckpt1 = join(root, 'ckpt-1');
        await mkdir(ckpt1, {recursive: true});
        await symlink(outsideDir, join(ckpt1, `entry-${witness.witnessId}`));
        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: ckpt1,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        })).rejects.toThrow(/symbolic link/u);
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-secret-payload');

        // Case 2: Symlinked artifacts directory inside an existing valid entry.
        const ckpt2 = join(root, 'ckpt-2');
        const initialHandle2 = await openScanCleanupConversionCheckpoint({
            checkpointDir: ckpt2,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        });
        const entry2Artifacts = join(initialHandle2.entryDir, 'artifacts');
        await initialHandle2.close();
        await rm(entry2Artifacts, {
            recursive: true,
            force: true,
        });
        await symlink(outsideDir, entry2Artifacts);
        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: ckpt2,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        })).rejects.toThrow(/symbolic link/u);
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-secret-payload');

        // Case 3 & 4: Symlinked page-1 directory and symlinked leaf file.
        const ckpt3 = join(root, 'ckpt-3');
        const scratch3 = join(root, 'scratch-3');
        const restoreScratch3 = join(root, 'restore-3');
        await Promise.all([
            mkdir(scratch3, {recursive: true}),
            mkdir(restoreScratch3, {recursive: true}),
        ]);
        const handle3 = await openScanCleanupConversionCheckpoint({
            checkpointDir: ckpt3,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        });
        const pageMetaPath = join(scratch3, 'clean-1-page.json');
        const outMetaPath = join(scratch3, 'clean-1-0.json');
        const outPngPath = join(scratch3, 'clean-1-0.png');
        await writeFile(pageMetaPath, JSON.stringify(pageMetadata()));
        await writeFile(outMetaPath, JSON.stringify(outputMetadata()));
        await writeFile(outPngPath, PNG);
        await handle3.commitCompletedPages([{
            pageNumber: 1,
            artifacts: [
                {
                    scratchPath: pageMetaPath,
                    fileName: 'clean-1-page.json',
                },
                {
                    scratchPath: outMetaPath,
                    fileName: 'clean-1-0.json',
                },
                {
                    scratchPath: outPngPath,
                    fileName: 'clean-1-0.png',
                },
            ],
        }], planSignature);

        // Case 4: Replace leaf clean-1-0.png with a symlink to an unreadable sentinelPath.
        // Making sentinelPath 0o000 verifies restore rejects via O_NOFOLLOW without
        // opening/reading the symlink target or writing anything to restoreScratch3.
        const storedPngPath = await resolveStoredPageArtifactPath(handle3.entryDir, 1, 'clean-1-0.png');
        await rm(storedPngPath, {force: true});
        await symlink(sentinelPath, storedPngPath);
        await chmod(sentinelPath, 0o000);
        try {
            const restoredLeaf = await handle3.restoreCompletedPages(restoreScratch3, [1], planSignature);
            expect(restoredLeaf.size).toBe(0);
            expect(await readdir(restoreScratch3)).toEqual([]);
        } finally {
            await chmod(sentinelPath, 0o644);
        }
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-secret-payload');

        // Case 3: Re-commit page 1, then replace page-1 dir with a symlink to outsideDir.
        await handle3.commitCompletedPages([{
            pageNumber: 1,
            artifacts: [
                {
                    scratchPath: pageMetaPath,
                    fileName: 'clean-1-page.json',
                },
                {
                    scratchPath: outMetaPath,
                    fileName: 'clean-1-0.json',
                },
                {
                    scratchPath: outPngPath,
                    fileName: 'clean-1-0.png',
                },
            ],
        }], planSignature);
        const storedPageDir = join(handle3.entryDir, 'artifacts', 'page-1');
        await rm(storedPageDir, {
            recursive: true,
            force: true,
        });
        await symlink(outsideDir, storedPageDir);
        await chmod(sentinelPath, 0o000);
        try {
            const restoredPageDir = await handle3.restoreCompletedPages(restoreScratch3, [1], planSignature);
            expect(restoredPageDir.size).toBe(0);
            expect(await readdir(restoreScratch3)).toEqual([]);
        } finally {
            await chmod(sentinelPath, 0o644);
        }
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-secret-payload');
        await handle3.complete();
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-secret-payload');
    });

    it('preserves per-page checkpoints when committing a batch manifest fails during atomic rename', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-ckpt-atomic-batch-'));
        roots.push(root);
        const checkpointDir = join(root, 'checkpoints');
        const scratch = join(root, 'scratch');
        const restoreScratch = join(root, 'restore-scratch');
        await Promise.all([
            mkdir(scratch, {recursive: true}),
            mkdir(restoreScratch, {recursive: true}),
        ]);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-atomic-batch');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-atomic-batch').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1, 2],
            documentPageCount: 2,
            documentCanvas: null,
            losslessRun: false,
        });
        const planSignature = computeScanCleanupRenderPlanSignature({
            documentCanvas: null,
            rasterFormat: 'ppm',
            pages: [],
        });

        let failManifestRename = false;
        const handle = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness,
            documentPageCount: 2,
            mode: 'streaming',
            log: () => undefined,
            fileSystem: {
                rename: async (oldPath, newPath) => {
                    if (failManifestRename && String(newPath).endsWith('checkpoint.json')) {
                        throw Object.assign(new Error('Simulated EIO during manifest rename'), {code: 'EIO'});
                    }
                    await rename(oldPath, newPath);
                },
            },
        });

        for (const pageNumber of [1, 2]) {
            const pageMetaPath = join(scratch, `clean-${String(pageNumber)}-page.json`);
            const outMetaPath = join(scratch, `clean-${String(pageNumber)}-0.json`);
            const outPngPath = join(scratch, `clean-${String(pageNumber)}-0.png`);
            await writeFile(pageMetaPath, JSON.stringify(pageMetadata()));
            await writeFile(outMetaPath, JSON.stringify(outputMetadata()));
            await writeFile(outPngPath, PNG);
            await handle.commitCompletedPages([{
                pageNumber,
                artifacts: [
                    {
                        scratchPath: pageMetaPath,
                        fileName: `clean-${String(pageNumber)}-page.json`,
                    },
                    {
                        scratchPath: outMetaPath,
                        fileName: `clean-${String(pageNumber)}-0.json`,
                    },
                    {
                        scratchPath: outPngPath,
                        fileName: `clean-${String(pageNumber)}-0.png`,
                    },
                ],
            }], planSignature, 'batch-0-pages');
        }

        const batchPdfPath = join(scratch, 'batch-0.pdf');
        await writeFile(batchPdfPath, '%PDF-1.7\n%%EOF\n');

        failManifestRename = true;
        await expect(handle.commitCompletedBatch({
            batchIndex: 0,
            firstPageNumber: 1,
            batchSignature: 'f'.repeat(64),
            batchPdfPath,
            summary: {
                inputPages: 2,
                outputPages: 2,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 0,
                blankPagesSkipped: 0,
                accessibilityTagsRemoved: false,
                warnings: [],
            },
            representationReport: null,
            provenanceStamp: null,
            sourceTextPages: [],
            skippedNonAffine: [],
        })).rejects.toThrow('Simulated EIO during manifest rename');
        await handle.close();

        // Reopen cleanly: because manifest rename failed, superseded page
        // checkpoints in `batch-0-pages` MUST still be intact and restorable.
        const reopened = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness,
            documentPageCount: 2,
            mode: 'streaming',
            log: () => undefined,
        });
        const restored = await reopened.restoreCompletedPages(restoreScratch, [1, 2], planSignature, 'batch-0-pages');
        expect([...restored].sort((left, right) => left - right)).toEqual([1, 2]);
        await reopened.complete();
    });

    it('never steals a live-PID checkpoint lock past 60s and rolls back leases on initialization failure', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-ckpt-lock-lease-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-lock-lease');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-lock-lease').digest('hex');
        const witnessA = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-a.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const witnessB = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-b.pdf'),
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            resolvedOptions: {
                ...baseOptions,
                crop: true,
            },
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        // 1. Live-PID lock older than 60s must never be stolen or unlinked.
        const lockDir = join(root, 'ckpt-live-lock');
        await mkdir(lockDir, {recursive: true});
        const lockPath = join(lockDir, '.checkpoint.lock');
        const lockPayload = JSON.stringify({
            pid: process.pid,
            token: 'live-owner-token',
            acquiredAtMs: Date.now() - 61_000,
        });
        await writeFile(lockPath, lockPayload, 'utf8');
        const staleTime = new Date(Date.now() - 61_000);
        await utimes(lockPath, staleTime, staleTime);

        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: lockDir,
            sourcePdfPath,
            witness: witnessA,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
            lockTimeoutMs: 50,
        })).rejects.toThrow(/Timed out waiting for scan cleanup checkpoint lock/u);
        expect(await readFile(lockPath, 'utf8')).toBe(lockPayload);

        // 2. Init failure after lease creation must remove both the on-disk
        // lease file and the in-process active-lease refcount.
        const rollbackDir = join(root, 'ckpt-init-rollback');
        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: rollbackDir,
            sourcePdfPath,
            witness: witnessA,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
            fileSystem: {
                rename: async (oldPath, newPath) => {
                    if (String(newPath).endsWith('checkpoint.json')) {
                        throw Object.assign(new Error('Simulated init manifest rename failure'), {code: 'EIO'});
                    }
                    await rename(oldPath, newPath);
                },
            },
        })).rejects.toThrow('Simulated init manifest rename failure');

        const abandonedEntryDir = join(rollbackDir, `entry-${witnessA.witnessId}`);
        const abandonedFiles = await readdir(abandonedEntryDir);
        expect(abandonedFiles.filter(name => name.startsWith('.lease-'))).toEqual([]);

        // Competing open on the same sourcePdfPath must reclaim the abandoned
        // entry cleanly (proving the in-process lease refcount was rolled back).
        const competingHandle = await openScanCleanupConversionCheckpoint({
            checkpointDir: rollbackDir,
            sourcePdfPath,
            witness: witnessB,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        });
        expect(existsSync(abandonedEntryDir)).toBe(false);
        await competingHandle.complete();
    });

    it('rejects a symlinked .checkpoint.lock without following or modifying its target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-ckpt-symlink-lock-'));
        roots.push(root);
        const outsideDir = join(root, 'outside');
        const sentinelPath = join(outsideDir, 'sentinel.txt');
        await mkdir(outsideDir, {recursive: true});
        await writeFile(sentinelPath, 'outside-lock-sentinel');

        const ckptDir = join(root, 'checkpoints');
        await mkdir(ckptDir, {recursive: true});
        await symlink(sentinelPath, join(ckptDir, '.checkpoint.lock'));

        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-symlink-lock');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-symlink-lock').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: ckptDir,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            log: () => undefined,
        })).rejects.toThrow(/symbolic link/u);
        expect(await readFile(sentinelPath, 'utf8')).toBe('outside-lock-sentinel');
    });

    it('invalidates xlarge batch checkpoints on batchRasterFacts drift and disables checkpointing when native tools cannot be hashed', async () => {
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);

        // 1. Changing per-page detected raster DPI/dimensions invalidates batch 0.
        const rasterFixture = await createStreamingFixture({
            pageCount: 3,
            useScratchDir: false,
            useCheckpointDir: true,
        });
        let page1Dpi = 300;
        let page1Width = 100;
        rasterFixture.dependencies.detectSourceDpi = vi.fn(async () => ({
            detected: true,
            documentDpi: page1Dpi,
            compactLayeredPageCount: 0,
            compactLayeredPageCountComplete: true,
            getPageRaster: (pageNumber: number) => ({
                dpi: pageNumber === 1 ? page1Dpi : 300,
                width: pageNumber === 1 ? page1Width : 100,
                height: 100,
            }),
        }));

        const abortRun1 = new AbortController();
        rasterFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            if (pages.includes(3)) {
                abortRun1.abort(new DOMException('Stop before batch 1', 'AbortError'));
                sig.throwIfAborted();
            }
            await rasterFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: rasterFixture.sourcePdfPath,
                outputPdfPath: rasterFixture.outputPdfPath,
                options: baseOptions,
            },
            rasterFixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            rasterFixture.dependencies,
        )).rejects.toThrow('Stop before batch 1');

        page1Dpi = 600;
        page1Width = 200;
        const run2Pages: number[] = [];
        rasterFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            run2Pages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await rasterFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const driftedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: rasterFixture.sourcePdfPath,
                outputPdfPath: rasterFixture.outputPdfPath,
                options: baseOptions,
            },
            rasterFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            rasterFixture.dependencies,
        );
        expect(driftedSummary.outputPages).toBe(3);
        expect(run2Pages).toEqual([1, 2, 3]);

        // 2. Unhashable native tool binary cleanly disables checkpoint creation
        // and reuse without failing conversion.
        const unhashableFixture = await createStreamingFixture({
            pageCount: 4,
            useScratchDir: false,
            useCheckpointDir: true,
            streamingHandoff: {
                maxInFlightPages: 4,
                maxChunkPages: 2,
            },
        });
        const abortSeed = new AbortController();
        let seedChunks = 0;
        unhashableFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            seedChunks += 1;
            if (seedChunks === 2) {
                abortSeed.abort(new DOMException('Stop after seeding chunk 0', 'AbortError'));
                sig.throwIfAborted();
            }
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            await unhashableFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(runScanCleanupConversion(
            {
                sourcePdfPath: unhashableFixture.sourcePdfPath,
                outputPdfPath: unhashableFixture.outputPdfPath,
                options: baseOptions,
            },
            unhashableFixture.workerPaths,
            abortSeed.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            unhashableFixture.dependencies,
        )).rejects.toThrow('Stop after seeding chunk 0');
        expect(await readdir(unhashableFixture.checkpointDir!)).toHaveLength(1);

        // Now make pdftoppm unhashable while keeping the provenance-stamp
        // binaries hashable: checkpointing must disable cleanly (no reuse of
        // the seeded checkpoint, and conversion still succeeds).
        unhashableFixture.dependencies.hashNativeBinary = vi.fn(async (binaryPath: string) => {
            if (binaryPath === unhashableFixture.workerPaths.pdftoppmBinary) {
                throw Object.assign(new Error(`ENOENT: ${binaryPath}`), {code: 'ENOENT'});
            }
            return 'a'.repeat(64);
        });
        const unhashableRunPages: number[] = [];
        unhashableFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            unhashableRunPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await unhashableFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const unhashableSummary = await runScanCleanupConversion(
            {
                sourcePdfPath: unhashableFixture.sourcePdfPath,
                outputPdfPath: unhashableFixture.outputPdfPath,
                options: baseOptions,
            },
            unhashableFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            unhashableFixture.dependencies,
        );
        expect(unhashableSummary.outputPages).toBe(4);
        expect(unhashableRunPages).toEqual([1, 2, 3, 4]);

        // Also confirm a fresh unhashable-binary run creates NO checkpoint dir
        // during processing (even while chunk 0 is in flight).
        const freshUnhashableFixture = await createStreamingFixture({
            pageCount: 2,
            useScratchDir: false,
            useCheckpointDir: true,
        });
        freshUnhashableFixture.dependencies.hashNativeBinary = vi.fn(async (binaryPath: string) => {
            if (binaryPath === freshUnhashableFixture.workerPaths.pdftoppmBinary) {
                throw Object.assign(new Error(`ENOENT: ${binaryPath}`), {code: 'ENOENT'});
            }
            return 'a'.repeat(64);
        });
        let checkpointDirExistedDuringSidecar = false;
        freshUnhashableFixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            checkpointDirExistedDuringSidecar = existsSync(freshUnhashableFixture.checkpointDir!);
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            await freshUnhashableFixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const freshSummary = await runScanCleanupConversion(
            {
                sourcePdfPath: freshUnhashableFixture.sourcePdfPath,
                outputPdfPath: freshUnhashableFixture.outputPdfPath,
                options: baseOptions,
            },
            freshUnhashableFixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            freshUnhashableFixture.dependencies,
        );
        expect(freshSummary.outputPages).toBe(2);
        expect(checkpointDirExistedDuringSidecar).toBe(false);
        expect(existsSync(freshUnhashableFixture.checkpointDir!)).toBe(false);
    });

    it('rejects nested malformed batch checkpoint state (null outputMapping or out-of-range sourceTextPages) and recomputes cleanly', async () => {
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);

        const runAndTamperBatch0 = async (mutate: (state: Record<string, unknown>) => void) => {
            const fixture = await createStreamingFixture({
                pageCount: 3,
                useScratchDir: false,
                useCheckpointDir: true,
            });
            const abortRun1 = new AbortController();
            fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
                const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
                const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
                if (pages.includes(3)) {
                    abortRun1.abort(new DOMException('Stop before batch 1', 'AbortError'));
                    sig.throwIfAborted();
                }
                await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
            });
            await expect(pipeline.runScanCleanupConversion(
                {
                    sourcePdfPath: fixture.sourcePdfPath,
                    outputPdfPath: fixture.outputPdfPath,
                    options: baseOptions,
                },
                fixture.workerPaths,
                abortRun1.signal,
                () => undefined,
                basePolicy,
                () => undefined,
                fixture.dependencies,
            )).rejects.toThrow('Stop before batch 1');

            const [entryName] = await readdir(fixture.checkpointDir!);
            const entryDir = join(fixture.checkpointDir!, entryName!);
            const manifestPath = join(entryDir, 'checkpoint.json');
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
                completedBatches: Record<string, {
                    stateFileName: string;
                    stateSizeBytes: number;
                    stateSha256: string;
                }>;
            };
            const batch0Record = manifest.completedBatches['0']!;
            const batch0StatePath = join(entryDir, 'artifacts', 'batch-0', batch0Record.stateFileName);
            const batch0State = JSON.parse(await readFile(batch0StatePath, 'utf8')) as Record<string, unknown>;
            mutate(batch0State);
            const mutatedText = `${JSON.stringify(batch0State, null, 2)}\n`;
            await writeFile(batch0StatePath, mutatedText);
            batch0Record.stateSizeBytes = Buffer.byteLength(mutatedText, 'utf8');
            batch0Record.stateSha256 = createHash('sha256').update(mutatedText).digest('hex');
            await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

            const run2Pages: number[] = [];
            fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
                const parsed = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
                run2Pages.push(...parsed.pages.map(page => page.sourcePageIndex + 1));
                await fixture.writeDefaultSidecarOutputs(parsed, onProgress);
            });
            const summary = await pipeline.runScanCleanupConversion(
                {
                    sourcePdfPath: fixture.sourcePdfPath,
                    outputPdfPath: fixture.outputPdfPath,
                    options: baseOptions,
                },
                fixture.workerPaths,
                new AbortController().signal,
                () => undefined,
                basePolicy,
                () => undefined,
                fixture.dependencies,
            );
            return {
                summary,
                run2Pages,
            };
        };

        // 1. Null element inside representationReport.outputMappings.
        const nullMappingResult = await runAndTamperBatch0(state => {
            const report = state.representationReport as {outputMappings: unknown[]};
            report.outputMappings[0] = null;
        });
        expect(nullMappingResult.summary.outputPages).toBe(3);
        expect(nullMappingResult.run2Pages).toEqual([1, 2, 3]);

        // 2. Out-of-range outputPageIndex inside sourceTextPages.
        const outOfRangeTextResult = await runAndTamperBatch0(state => {
            state.sourceTextPages = [{
                sourcePageIndex: 0,
                outputPageIndex: 5000,
                matrix: [1, 0, 0, 1, 0, 0],
            }];
        });
        expect(outOfRangeTextResult.summary.outputPages).toBe(3);
        expect(outOfRangeTextResult.run2Pages).toEqual([1, 2, 3]);

        // 3. Digest-valid batch checkpoint claiming hasBatchPdf: true with
        // summary.outputPages: 0, representationReport: null, provenanceStamp: null
        // must be rejected and recomputed rather than silently omitted from merge.
        const contradictoryPdfZeroPagesResult = await runAndTamperBatch0(state => {
            const summaryObj = state.summary as Record<string, unknown>;
            summaryObj.outputPages = 0;
            state.hasBatchPdf = true;
            state.representationReport = null;
            state.provenanceStamp = null;
            state.sourceTextPages = [];
        });
        expect(contradictoryPdfZeroPagesResult.summary.outputPages).toBe(3);
        expect(contradictoryPdfZeroPagesResult.run2Pages).toEqual([1, 2, 3]);
    });

    it('preserves full-document Auto compact-source budget completeness when resuming an xlarge run with locked color recommendations', async () => {
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);
        const fixture = await createStreamingFixture({
            pageCount: 3,
            useScratchDir: false,
            useCheckpointDir: true,
        });
        const autoOptions: IScanCleanupOptions = {
            ...baseOptions,
            outputMode: 'auto',
            matchPageSize: false,
        };
        const outputModeRecommendations = {
            '1': 'color' as const,
            '2': 'color' as const,
            '3': 'color' as const,
        };

        const abortRun1 = new AbortController();
        fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            const pages = manifest.pages.map(page => page.sourcePageIndex + 1);
            if (pages.includes(3)) {
                abortRun1.abort(new DOMException('Stop full-doc Auto before batch 1', 'AbortError'));
                sig.throwIfAborted();
            }
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: autoOptions,
                outputModeRecommendations,
            },
            fixture.workerPaths,
            abortRun1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        )).rejects.toThrow('Stop full-doc Auto before batch 1');

        const resumedSidecarPages: number[] = [];
        fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            resumedSidecarPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const resumedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options: autoOptions,
                outputModeRecommendations,
            },
            fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            fixture.dependencies,
        );
        expect(resumedSummary).toMatchObject({
            inputPages: 3,
            outputPages: 3,
        });
        // Batch 0 (pages 1..2) restored from checkpoint while still advancing
        // the ordered source-raster probe so full-document Auto publication succeeds.
        expect(resumedSidecarPages).toEqual([3]);
        expect(await readdir(fixture.checkpointDir!)).toEqual([]);
    });

    it('restores multi-chunk batch PDFs via single-pass streaming digest and rejects same-size mid-file corruption', async () => {
        const pipeline = await loadScanCleanupPipelineWithBatchPages(2);
        // 192 KiB payload (> 3x the 64 KiB streaming chunk size).
        const largeBatchPdf = Buffer.concat([
            Buffer.from('%PDF-1.7\n'),
            Buffer.alloc(192 * 1024, 0x41),
            Buffer.from('\n%%EOF\n'),
        ]);

        const createLargeBatchFixture = async () => {
            const fixture = await createStreamingFixture({
                pageCount: 3,
                useScratchDir: false,
                useCheckpointDir: true,
            });
            let capturedRestoredBatch0Bytes: Buffer | null = null;
            const baseRunCommand = fixture.dependencies.runCommand;
            fixture.dependencies.runCommand = vi.fn<IRunScanCleanupPipelineDependencies['runCommand']>(async (binary, args, options) => {
                if (binary === fixture.workerPaths.pdfImageCombineBinary) {
                    const outputPath = args[args.indexOf('--output') + 1]!;
                    await writeFile(outputPath, largeBatchPdf);
                    return {
                        exitCode: 0,
                        stdout: '',
                        stderr: '',
                    };
                }
                // During final qpdf merge, read the batch-0 PDF input from disk
                // so we can assert its streamed restored bytes match bit-for-bit.
                if (binary === fixture.workerPaths.qpdfBinary && args.includes('--pages')) {
                    const batch0Arg = args.find(arg => arg.endsWith('batch-0.pdf'));
                    if (batch0Arg !== undefined) {
                        capturedRestoredBatch0Bytes = await readFile(batch0Arg);
                    }
                }
                return baseRunCommand(binary, args, options);
            });
            return {
                fixture,
                getCapturedBatch0Bytes: () => capturedRestoredBatch0Bytes,
            };
        };

        // 1. Clean multi-chunk streaming restore matches bit-for-bit and skips batch 0 sidecar.
        const cleanRun = await createLargeBatchFixture();
        const abort1 = new AbortController();
        cleanRun.fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            if (manifest.pages.some(page => page.sourcePageIndex + 1 === 3)) {
                abort1.abort(new DOMException('Stop after large batch 0', 'AbortError'));
                sig.throwIfAborted();
            }
            await cleanRun.fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: cleanRun.fixture.sourcePdfPath,
                outputPdfPath: cleanRun.fixture.outputPdfPath,
                options: baseOptions,
            },
            cleanRun.fixture.workerPaths,
            abort1.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            cleanRun.fixture.dependencies,
        )).rejects.toThrow('Stop after large batch 0');

        const cleanResumedPages: number[] = [];
        cleanRun.fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            cleanResumedPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await cleanRun.fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const cleanSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: cleanRun.fixture.sourcePdfPath,
                outputPdfPath: cleanRun.fixture.outputPdfPath,
                options: baseOptions,
            },
            cleanRun.fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            cleanRun.fixture.dependencies,
        );
        expect(cleanSummary.outputPages).toBe(3);
        expect(cleanResumedPages).toEqual([3]);
        expect(cleanRun.getCapturedBatch0Bytes()?.equals(largeBatchPdf)).toBe(true);

        // 2. Single-byte corruption in the middle of the stored 192 KiB batch PDF
        // is rejected during streamed verification and batch 0 recomputes cleanly.
        const corruptRun = await createLargeBatchFixture();
        const abort2 = new AbortController();
        corruptRun.fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            if (manifest.pages.some(page => page.sourcePageIndex + 1 === 3)) {
                abort2.abort(new DOMException('Stop before corrupting batch 0', 'AbortError'));
                sig.throwIfAborted();
            }
            await corruptRun.fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        await expect(pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: corruptRun.fixture.sourcePdfPath,
                outputPdfPath: corruptRun.fixture.outputPdfPath,
                options: baseOptions,
            },
            corruptRun.fixture.workerPaths,
            abort2.signal,
            () => undefined,
            basePolicy,
            () => undefined,
            corruptRun.fixture.dependencies,
        )).rejects.toThrow('Stop before corrupting batch 0');

        const [entryName] = await readdir(corruptRun.fixture.checkpointDir!);
        const storedBatchPdfPath = await resolveStoredBatchPdfPath(
            join(corruptRun.fixture.checkpointDir!, entryName!),
            0,
        );
        const tamperedPdf = Buffer.from(await readFile(storedBatchPdfPath));
        const midOffset = 96 * 1024;
        tamperedPdf[midOffset] = (tamperedPdf[midOffset]! ^ 0xff) & 0xff;
        await writeFile(storedBatchPdfPath, tamperedPdf);

        const corruptResumedPages: number[] = [];
        corruptRun.fixture.dependencies.runSidecar = vi.fn(async (_binary, mPath, _sig, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(mPath, 'utf8')) as {pages: ITestManifestPage[]};
            corruptResumedPages.push(...manifest.pages.map(page => page.sourcePageIndex + 1));
            await corruptRun.fixture.writeDefaultSidecarOutputs(manifest, onProgress);
        });
        const repairedSummary = await pipeline.runScanCleanupConversion(
            {
                sourcePdfPath: corruptRun.fixture.sourcePdfPath,
                outputPdfPath: corruptRun.fixture.outputPdfPath,
                options: baseOptions,
            },
            corruptRun.fixture.workerPaths,
            new AbortController().signal,
            () => undefined,
            basePolicy,
            () => undefined,
            corruptRun.fixture.dependencies,
        );
        expect(repairedSummary.outputPages).toBe(3);
        expect(corruptResumedPages).toEqual([1, 2, 3]);
    });

    it('reclaims checkpoint lock and entry lease owned by a force-terminated Node worker sharing process.pid', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-worker-owner-reclaim-'));
        roots.push(root);
        const checkpointDir = join(root, 'checkpoints');
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-worker-force-term');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-worker-force-term').digest('hex');
        const witnessA = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-a.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const witnessB = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-b.pdf'),
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            resolvedOptions: {
                ...baseOptions,
                crop: true,
            },
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        const workerSource = `
            import {rename} from 'node:fs/promises';
            import {parentPort, workerData} from 'node:worker_threads';
            import {openScanCleanupConversionCheckpoint} from '@evb/scan-cleanup/core/conversionCheckpoint';

            const data = workerData as {
                checkpointDir: string;
                sourcePdfPath: string;
                witness: {sourceSha256: string; optionsSignature: string; witnessId: string};
                ownerId: string;
            };
            void openScanCleanupConversionCheckpoint({
                checkpointDir: data.checkpointDir,
                sourcePdfPath: data.sourcePdfPath,
                witness: data.witness,
                documentPageCount: 1,
                mode: 'batch',
                ownerId: data.ownerId,
                log: () => undefined,
                fileSystem: {
                    rename: async (oldPath, newPath) => {
                        if (String(newPath).endsWith('checkpoint.json')) {
                            parentPort?.postMessage({kind: 'holding-lock-and-lease'});
                            await new Promise(() => undefined);
                        }
                        await rename(oldPath, newPath);
                    },
                },
            });
        `;
        const built = await buildWithEsbuild({
            bundle: true,
            format: 'cjs',
            platform: 'node',
            target: 'node22',
            tsconfig: resolve(process.cwd(), 'tsconfig.base.json'),
            write: false,
            stdin: {
                contents: workerSource,
                loader: 'ts',
                resolveDir: process.cwd(),
                sourcefile: 'checkpoint-owner-force-term-worker.ts',
            },
        });
        const workerCode = built.outputFiles[0]!.text;
        const ownerId = 'worker-job-force-term-1';
        const worker = new Worker(workerCode, {
            eval: true,
            workerData: {
                checkpointDir,
                sourcePdfPath,
                witness: witnessA,
                ownerId,
            },
        });

        try {
            const holding = Promise.withResolvers<void>();
            worker.on('message', (message: {kind?: string}) => {
                if (message.kind === 'holding-lock-and-lease') {
                    holding.resolve();
                }
            });
            worker.on('error', error => holding.reject(error));
            await holding.promise;

            // Worker shares process.pid and currently holds BOTH .checkpoint.lock
            // and .lease-* inside entry-<witnessId>.
            const lockPath = join(checkpointDir, '.checkpoint.lock');
            const lockData = JSON.parse(await readFile(lockPath, 'utf8')) as {
                pid: number;
                ownerId: string;
            };
            expect(lockData.pid).toBe(process.pid);
            expect(lockData.ownerId).toBe(ownerId);

            const entryDir = join(checkpointDir, `entry-${witnessA.witnessId}`);
            const entryFilesBefore = await readdir(entryDir);
            expect(entryFilesBefore.filter(name => name.startsWith('.lease-'))).toHaveLength(1);

            await expect(openScanCleanupConversionCheckpoint({
                checkpointDir,
                sourcePdfPath,
                witness: witnessB,
                documentPageCount: 1,
                mode: 'batch',
                log: () => undefined,
                lockTimeoutMs: 50,
            })).rejects.toThrow(/Timed out waiting for scan cleanup checkpoint lock/u);

            // Force-terminate the worker thread and wait for confirmed exit.
            await worker.terminate();

            // Because the worker shared process.pid with main, the lock is still
            // on disk until owner reclamation runs post-exit.
            expect(existsSync(lockPath)).toBe(true);

            const reclaimed = await reclaimScanCleanupCheckpointOwner(checkpointDir, ownerId);
            expect(reclaimed.reclaimedDirLock).toBe(true);
            expect(reclaimed.reclaimedLeases).toBe(1);
            expect(existsSync(lockPath)).toBe(false);
            const entryFilesAfter = await readdir(entryDir);
            expect(entryFilesAfter.filter(name => name.startsWith('.lease-'))).toEqual([]);

            // Next open succeeds immediately and reclaims the unleased abandoned entry.
            const nextHandle = await openScanCleanupConversionCheckpoint({
                checkpointDir,
                sourcePdfPath,
                witness: witnessB,
                documentPageCount: 1,
                mode: 'batch',
                log: () => undefined,
                lockTimeoutMs: 500,
            });
            expect(existsSync(entryDir)).toBe(false);
            await nextHandle.complete();
        } finally {
            await worker.terminate().catch(() => undefined);
        }
    });

    const createContenderWorkerHarness = async () => {
        const workerSource = `
            import {rename} from 'node:fs/promises';
            import {parentPort, workerData} from 'node:worker_threads';
            import {openScanCleanupConversionCheckpoint} from '@evb/scan-cleanup/core/conversionCheckpoint';

            const data = workerData as {
                checkpointDir: string;
                sourcePdfPath: string;
                witness: {sourceSha256: string; optionsSignature: string; witnessId: string};
                ownerId: string;
                pauseAtLockLstatHit?: number;
                pauseAfterLockOpenBeforeWrite?: boolean;
                pauseBeforeReclaim?: boolean;
                pauseAtUnlink?: boolean;
                pauseAtRename?: boolean;
            };
            const waiters = new Map<string, () => void>();
            parentPort?.on('message', (message: {release?: string}) => {
                if (typeof message.release === 'string') {
                    const resolver = waiters.get(message.release);
                    waiters.delete(message.release);
                    resolver?.();
                }
            });
            const waitForRelease = (stage: string, extra: Record<string, unknown> = {}) => new Promise<void>(resolveStage => {
                waiters.set(stage, resolveStage);
                parentPort?.postMessage({kind: stage, ...extra});
            });
            let lstatHits = 0;
            let pausedOpenOnce = false;
            let pausedReclaimOnce = false;
            let pausedUnlinkOnce = false;
            let pausedRenameOnce = false;

            void (async () => {
                try {
                    const handle = await openScanCleanupConversionCheckpoint({
                        checkpointDir: data.checkpointDir,
                        sourcePdfPath: data.sourcePdfPath,
                        witness: data.witness,
                        documentPageCount: 1,
                        mode: 'batch',
                        ownerId: data.ownerId,
                        log: () => undefined,
                        fileSystem: {
                            afterLockLstat: async info => {
                                lstatHits += 1;
                                parentPort?.postMessage({kind: \`lstatHit-\${String(lstatHits)}\`, ...info});
                                if (lstatHits === data.pauseAtLockLstatHit) {
                                    await waitForRelease('afterLockLstat', info);
                                }
                            },
                            ...(data.pauseAfterLockOpenBeforeWrite
                                ? {
                                    afterLockOpenBeforeWrite: async info => {
                                        if (!pausedOpenOnce) {
                                            pausedOpenOnce = true;
                                            await waitForRelease('afterLockOpenBeforeWrite', info);
                                        }
                                    },
                                }
                                : {}),
                            beforeStaleLockReclaim: async info => {
                                parentPort?.postMessage({kind: 'sawStaleLock', ...info});
                                parentPort?.postMessage({kind: 'enteredReclaim', ...info});
                                if (data.pauseBeforeReclaim && !pausedReclaimOnce) {
                                    pausedReclaimOnce = true;
                                    await waitForRelease('beforeStaleLockReclaim', info);
                                }
                            },
                            beforeStaleLockUnlink: async info => {
                                if (data.pauseAtUnlink && !pausedUnlinkOnce) {
                                    pausedUnlinkOnce = true;
                                    await waitForRelease('beforeStaleLockUnlink', info);
                                }
                            },
                            rename: async (oldPath, newPath) => {
                                if (data.pauseAtRename && !pausedRenameOnce && String(newPath).endsWith('checkpoint.json')) {
                                    pausedRenameOnce = true;
                                    await waitForRelease('atRename');
                                }
                                await rename(oldPath, newPath);
                            },
                        },
                    });
                    await handle.close();
                    parentPort?.postMessage({kind: 'done'});
                } catch (error) {
                    parentPort?.postMessage({
                        kind: 'error',
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            })();
        `;
        const built = await buildWithEsbuild({
            bundle: true,
            format: 'cjs',
            platform: 'node',
            target: 'node22',
            tsconfig: resolve(process.cwd(), 'tsconfig.base.json'),
            write: false,
            stdin: {
                contents: workerSource,
                loader: 'ts',
                resolveDir: process.cwd(),
                sourcefile: 'checkpoint-contender-harness-worker.ts',
            },
        });
        const workerCode = built.outputFiles[0]!.text;

        return (workerData: Record<string, unknown>) => {
            const worker = new Worker(workerCode, {
                eval: true,
                workerData,
            });
            const events = new Map<string, PromiseWithResolvers<Record<string, unknown>>>();
            const received = new Map<string, Record<string, unknown>>();
            let doneFlag = false;
            let terminalFailure: Error | null = null;
            const done = Promise.withResolvers<void>();
            const failAllPending = (error: Error) => {
                terminalFailure ??= error;
                done.reject(error);
                for (const waiter of events.values()) {
                    waiter.reject(error);
                }
                events.clear();
            };
            worker.on('message', (message: Record<string, unknown>) => {
                const kind = String(message.kind ?? '');
                if (kind === 'done') {
                    doneFlag = true;
                    done.resolve();
                    for (const [
                        stage,
                        waiter,
                    ] of events) {
                        waiter.reject(new Error(`Contender worker finished before reaching stage "${stage}"`));
                    }
                    events.clear();
                    return;
                }
                if (kind === 'error') {
                    failAllPending(new Error(String(message.message ?? 'worker error')));
                    return;
                }
                received.set(kind, message);
                events.get(kind)?.resolve(message);
                events.delete(kind);
            });
            worker.on('error', error => {
                failAllPending(error instanceof Error ? error : new Error(String(error)));
            });
            worker.on('exit', code => {
                if (!doneFlag) {
                    failAllPending(new Error(`Contender worker exited early with code ${String(code)}`));
                }
            });
            return {
                worker,
                done: done.promise,
                isDone: () => doneFlag,
                sawEvent: (stage: string) => received.has(stage),
                waitFor(stage: string) {
                    const existing = received.get(stage);
                    if (existing !== undefined) {
                        return Promise.resolve(existing);
                    }
                    if (terminalFailure !== null) {
                        return Promise.reject(terminalFailure);
                    }
                    if (doneFlag) {
                        return Promise.reject(new Error(`Contender worker already finished before stage "${stage}"`));
                    }
                    let waiter = events.get(stage);
                    if (waiter === undefined) {
                        waiter = Promise.withResolvers<Record<string, unknown>>();
                        events.set(stage, waiter);
                    }
                    return waiter.promise;
                },
                release(stage: string) {
                    worker.postMessage({release: stage});
                },
            };
        };
    };

    it('serializes concurrent stale-lock reclamation via token-keyed reclaim locks without ever unlinking a live successor lock', async () => {
        const spawnContender = await createContenderWorkerHarness();

        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-reclaim-race-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-reclaim-race');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-reclaim-race').digest('hex');
        const witnessA = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-a.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const witnessB = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-b.pdf'),
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            resolvedOptions: {
                ...baseOptions,
                crop: true,
            },
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        // Interleaving 1: Two contenders concurrently discover the same stale
        // lock while Contender A pauses inside the token-keyed reclaim lock.
        const ckptDir1 = join(root, 'ckpt-interleaving-1');
        await mkdir(ckptDir1, {recursive: true});
        const staleToken1 = 'deadtoken11111111111111111111111';
        await writeFile(join(ckptDir1, '.checkpoint.lock'), JSON.stringify({
            pid: 999_999_999,
            ownerId: 'dead-owner-1',
            token: staleToken1,
            acquiredAtMs: Date.now() - 10_000,
        }));

        const contenderA1 = spawnContender({
            checkpointDir: ckptDir1,
            sourcePdfPath,
            witness: witnessA,
            ownerId: 'contender-a1',
            pauseAtUnlink: true,
            pauseAtRename: true,
        });
        let contenderB1: ReturnType<typeof spawnContender> | null = null;
        try {
            const unlinkInfo = await contenderA1.waitFor('beforeStaleLockUnlink');
            expect(unlinkInfo.reclaimFileName).toBe(`.checkpoint.reclaim-${staleToken1}`);
            expect(existsSync(join(ckptDir1, `.checkpoint.reclaim-${staleToken1}`))).toBe(true);

            // Spawn Contender B1 while A1 holds `.checkpoint.reclaim-<staleToken1>`:
            // B1 observes the same stale lock, gets EEXIST on the reclaim lock,
            // and must wait cleanly without touching `.checkpoint.lock`. B1
            // parks on its next poll of the still-present stale lock, so it
            // cannot take the free `.checkpoint.lock` in the gap between A1's
            // unlink and A1's create; winning that gap is legal for a mutex
            // without fairness, but it is not the interleaving under test.
            contenderB1 = spawnContender({
                checkpointDir: ckptDir1,
                sourcePdfPath,
                witness: witnessB,
                ownerId: 'contender-b1',
                pauseAtLockLstatHit: 2,
            });
            await contenderB1.waitFor('sawStaleLock');
            await contenderB1.waitFor('afterLockLstat');
            const staleLockWhileBWaits = JSON.parse(await readFile(join(ckptDir1, '.checkpoint.lock'), 'utf8')) as {
                token: string;
            };
            expect(staleLockWhileBWaits.token).toBe(staleToken1);
            expect(existsSync(join(ckptDir1, `.checkpoint.reclaim-${staleToken1}`))).toBe(true);

            // Release A1 to unlink the stale lock and acquire a fresh live lock.
            contenderA1.release('beforeStaleLockUnlink');
            await contenderA1.waitFor('atRename');

            // While A1 holds the live lock, B1 must NOT steal or complete:
            // lstat hit 3 proves B1 read A1's live lock, declined it and polled again.
            contenderB1.release('afterLockLstat');
            await contenderB1.waitFor('lstatHit-3');
            const liveLock1 = JSON.parse(await readFile(join(ckptDir1, '.checkpoint.lock'), 'utf8')) as {
                pid: number;
                ownerId: string;
                token: string;
            };
            expect(liveLock1.pid).toBe(process.pid);
            expect(liveLock1.ownerId).toBe('contender-a1');
            expect(liveLock1.token).not.toBe(staleToken1);
            expect(contenderB1.isDone()).toBe(false);

            contenderA1.release('atRename');
            await Promise.all([
                contenderA1.done,
                contenderB1.done,
            ]);
            const leftover1 = (await readdir(ckptDir1)).filter(name => name.startsWith('.checkpoint.'));
            expect(leftover1).toEqual([]);
        } finally {
            await Promise.all([
                contenderA1.worker.terminate().catch(() => undefined),
                contenderB1?.worker.terminate().catch(() => undefined),
            ]);
        }

        // Interleaving 2: Delayed Contender B wakes up AFTER Contender A
        // already reclaimed the stale lock, cleaned up `.checkpoint.reclaim-<stale>`,
        // and acquired a fresh live lock with a new 128-bit token.
        const ckptDir2 = join(root, 'ckpt-interleaving-2');
        await mkdir(ckptDir2, {recursive: true});
        const staleToken2 = 'deadtoken22222222222222222222222';
        await writeFile(join(ckptDir2, '.checkpoint.lock'), JSON.stringify({
            pid: 999_999_999,
            ownerId: 'dead-owner-2',
            token: staleToken2,
            acquiredAtMs: Date.now() - 10_000,
        }));

        const contenderB2 = spawnContender({
            checkpointDir: ckptDir2,
            sourcePdfPath,
            witness: witnessB,
            ownerId: 'contender-b2',
            pauseBeforeReclaim: true,
            pauseAtUnlink: true,
        });
        let contenderA2: ReturnType<typeof spawnContender> | null = null;
        try {
            // B2 observed staleToken2 and paused BEFORE creating the reclaim lock.
            await contenderB2.waitFor('beforeStaleLockReclaim');

            // A2 reclaims staleToken2, cleans up its reclaim lock, and acquires
            // a brand-new live `.checkpoint.lock` with a fresh token.
            contenderA2 = spawnContender({
                checkpointDir: ckptDir2,
                sourcePdfPath,
                witness: witnessA,
                ownerId: 'contender-a2',
                pauseAtRename: true,
            });
            await contenderA2.waitFor('atRename');

            const liveLockBeforeB2 = JSON.parse(await readFile(join(ckptDir2, '.checkpoint.lock'), 'utf8')) as {
                pid: number;
                ownerId: string;
                token: string;
            };
            expect(liveLockBeforeB2.ownerId).toBe('contender-a2');
            expect(liveLockBeforeB2.token).not.toBe(staleToken2);
            expect(existsSync(join(ckptDir2, `.checkpoint.reclaim-${staleToken2}`))).toBe(false);

            // Wake delayed B2: it creates `.checkpoint.reclaim-<staleToken2>` and
            // enters the unlink check, then MUST see token mismatch and refuse to
            // unlink A2's live lock!
            contenderB2.release('beforeStaleLockReclaim');
            await contenderB2.waitFor('beforeStaleLockUnlink');
            contenderB2.release('beforeStaleLockUnlink');

            await expect.poll(() => existsSync(join(ckptDir2, `.checkpoint.reclaim-${staleToken2}`))).toBe(false);
            const liveLockAfterB2 = JSON.parse(await readFile(join(ckptDir2, '.checkpoint.lock'), 'utf8')) as {
                pid: number;
                ownerId: string;
                token: string;
            };
            expect(liveLockAfterB2.ownerId).toBe('contender-a2');
            expect(liveLockAfterB2.token).toBe(liveLockBeforeB2.token);
            expect(contenderB2.isDone()).toBe(false);

            contenderA2.release('atRename');
            await Promise.all([
                contenderA2.done,
                contenderB2.done,
            ]);
            const leftover2 = (await readdir(ckptDir2)).filter(name => name.startsWith('.checkpoint.'));
            expect(leftover2).toEqual([]);
        } finally {
            await Promise.all([
                contenderA2?.worker.terminate().catch(() => undefined),
                contenderB2.worker.terminate().catch(() => undefined),
            ]);
        }
    });

    it('preserves live and young-corrupt lock temp files while sweeping dead-PID, expired-corrupt, and non-lock temp files in rootRealPath', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-lock-tmp-race-'));
        roots.push(root);
        const ckptDir = join(root, 'ckpt');
        await mkdir(ckptDir, {recursive: true});
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-lock-tmp-race');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-lock-tmp-race').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        const liveDirLockTmp = join(ckptDir, '.checkpoint.lock.live-contender-uuid.tmp');
        const liveReclaimLockTmp = join(ckptDir, '.checkpoint.reclaim-deadtoken123.live-contender-uuid.tmp');
        const deadDirLockTmp = join(ckptDir, '.checkpoint.lock.dead-contender-uuid.tmp');
        const deadReclaimLockTmp = join(ckptDir, '.checkpoint.reclaim-deadtoken456.dead-contender-uuid.tmp');
        const youngCorruptLockTmp = join(ckptDir, '.checkpoint.lock.young-corrupt-uuid.tmp');
        const oldCorruptLockTmp = join(ckptDir, '.checkpoint.lock.old-corrupt-uuid.tmp');
        const youngEmptyReclaimTmp = join(ckptDir, '.checkpoint.reclaim-deadtoken789.young-empty-uuid.tmp');
        const oldCorruptReclaimTmp = join(ckptDir, '.checkpoint.reclaim-deadtoken999.old-corrupt-uuid.tmp');
        const strayNonLockTmp = join(ckptDir, 'stray-artifact.tmp');

        const nowMs = Date.now();
        await Promise.all([
            writeFile(liveDirLockTmp, JSON.stringify({
                pid: process.pid,
                ownerId: 'live-contender-dir',
                token: 'livetoken11111111111111111111111',
                acquiredAtMs: nowMs,
            })),
            writeFile(liveReclaimLockTmp, JSON.stringify({
                pid: process.pid,
                ownerId: 'live-contender-reclaim',
                token: 'livereclaim111111111111111111111',
                acquiredAtMs: nowMs,
            })),
            writeFile(deadDirLockTmp, JSON.stringify({
                pid: 999_999_999,
                ownerId: 'dead-contender-dir',
                token: 'deadtoken11111111111111111111111',
                acquiredAtMs: nowMs - 10_000,
            })),
            writeFile(deadReclaimLockTmp, JSON.stringify({
                pid: 999_999_999,
                ownerId: 'dead-contender-reclaim',
                token: 'deadreclaim111111111111111111111',
                acquiredAtMs: nowMs - 10_000,
            })),
            writeFile(youngCorruptLockTmp, ''),
            writeFile(oldCorruptLockTmp, '{corrupt'),
            writeFile(youngEmptyReclaimTmp, ''),
            writeFile(oldCorruptReclaimTmp, '{corrupt'),
            writeFile(strayNonLockTmp, 'stray-temp-bytes'),
        ]);

        const expiredTime = new Date(nowMs - 15_000);
        await Promise.all([
            utimes(oldCorruptLockTmp, expiredTime, expiredTime),
            utimes(oldCorruptReclaimTmp, expiredTime, expiredTime),
        ]);

        const handle = await openScanCleanupConversionCheckpoint({
            checkpointDir: ckptDir,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            ownerId: 'opener-owner',
            log: () => undefined,
        });
        try {
            // Live-PID and young empty/corrupt lock temp files MUST remain untouched.
            expect(existsSync(liveDirLockTmp)).toBe(true);
            expect(existsSync(liveReclaimLockTmp)).toBe(true);
            expect(existsSync(youngCorruptLockTmp)).toBe(true);
            expect(existsSync(youngEmptyReclaimTmp)).toBe(true);

            // Dead-PID lock temp files, expired corrupt lock temp files, and non-lock stray .tmp files MUST be swept.
            expect(existsSync(deadDirLockTmp)).toBe(false);
            expect(existsSync(deadReclaimLockTmp)).toBe(false);
            expect(existsSync(oldCorruptLockTmp)).toBe(false);
            expect(existsSync(oldCorruptReclaimTmp)).toBe(false);
            expect(existsSync(strayNonLockTmp)).toBe(false);
        } finally {
            await handle.close();
        }
    });

    it('reclaims checkpoints cleanly when a Worker is terminated during atomic lease creation or leaves a 0-byte owner-tagged lease file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-worker-mid-lease-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-mid-lease-term');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-mid-lease-term').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        // Case A: Real Worker force-terminated mid-atomic-lease-creation
        // (after staging `.lease-...lock.<uuid>.tmp`, before renaming into `.lock`).
        const ckptDirA = join(root, 'ckpt-mid-lease');
        const workerSource = `
            import {rename} from 'node:fs/promises';
            import {parentPort, workerData} from 'node:worker_threads';
            import {openScanCleanupConversionCheckpoint} from '@evb/scan-cleanup/core/conversionCheckpoint';

            const data = workerData as {
                checkpointDir: string;
                sourcePdfPath: string;
                witness: {sourceSha256: string; optionsSignature: string; witnessId: string};
                ownerId: string;
            };
            void openScanCleanupConversionCheckpoint({
                checkpointDir: data.checkpointDir,
                sourcePdfPath: data.sourcePdfPath,
                witness: data.witness,
                documentPageCount: 1,
                mode: 'batch',
                ownerId: data.ownerId,
                log: () => undefined,
                fileSystem: {
                    rename: async (oldPath, newPath) => {
                        if (String(newPath).endsWith('.lock')) {
                            parentPort?.postMessage({kind: 'mid-lease-publish'});
                            await new Promise(() => undefined);
                        }
                        await rename(oldPath, newPath);
                    },
                },
            });
        `;
        const built = await buildWithEsbuild({
            bundle: true,
            format: 'cjs',
            platform: 'node',
            target: 'node22',
            tsconfig: resolve(process.cwd(), 'tsconfig.base.json'),
            write: false,
            stdin: {
                contents: workerSource,
                loader: 'ts',
                resolveDir: process.cwd(),
                sourcefile: 'checkpoint-mid-lease-term-worker.ts',
            },
        });
        const ownerIdA = 'worker-mid-lease-1';
        const worker = new Worker(built.outputFiles[0]!.text, {
            eval: true,
            workerData: {
                checkpointDir: ckptDirA,
                sourcePdfPath,
                witness,
                ownerId: ownerIdA,
            },
        });
        try {
            const paused = Promise.withResolvers<void>();
            worker.on('message', (message: {kind?: string}) => {
                if (message.kind === 'mid-lease-publish') {
                    paused.resolve();
                }
            });
            worker.on('error', error => paused.reject(error));
            await paused.promise;

            const entryDirA = join(ckptDirA, `entry-${witness.witnessId}`);
            const stagedFiles = await readdir(entryDirA);
            expect(stagedFiles.some(name => name.startsWith('.lease-') && name.endsWith('.tmp'))).toBe(true);
            expect(stagedFiles.filter(name => name.startsWith('.lease-') && name.endsWith('.lock'))).toEqual([]);

            await worker.terminate();

            const reclaimedA = await reclaimScanCleanupCheckpointOwner(ckptDirA, ownerIdA);
            expect(reclaimedA.reclaimedDirLock).toBe(true);
            expect(existsSync(join(ckptDirA, '.checkpoint.lock'))).toBe(false);
            expect((await readdir(entryDirA)).filter(name => name.endsWith('.tmp'))).toEqual([]);
            await expect(reclaimScanCleanupCheckpoint(ckptDirA, entryDirA)).resolves.toBe(true);
            expect(existsSync(entryDirA)).toBe(false);
        } finally {
            await worker.terminate().catch(() => undefined);
        }

        // Case B: Empty (0-byte) owner-tagged lease file sharing Electron's live
        // process.pid must be reclaimed by `reclaimScanCleanupCheckpointOwner`
        // so `reclaimScanCleanupCheckpoint` returns `true` instead of pinning forever.
        const ckptDirB = join(root, 'ckpt-empty-lease');
        const ownerIdB = 'worker-empty-lease-owner';
        const handleB = await openScanCleanupConversionCheckpoint({
            checkpointDir: ckptDirB,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            ownerId: 'initial-creator',
            log: () => undefined,
        });
        const entryDirB = handleB.entryDir;
        await handleB.close();

        const ownerTagB = createHash('sha256').update(ownerIdB, 'utf8').digest('hex').slice(0, 32);
        const emptyLeasePath = join(entryDirB, `.lease-${String(process.pid)}-${ownerTagB}-truncated.lock`);
        await writeFile(emptyLeasePath, '');

        // While the 0-byte live-PID lease exists, entry reclamation refuses.
        await expect(reclaimScanCleanupCheckpoint(ckptDirB, entryDirB)).resolves.toBe(false);
        expect(existsSync(entryDirB)).toBe(true);

        // Owner reclamation identifies the 0-byte lease by (pid, ownerTag) and removes it.
        const reclaimedB = await reclaimScanCleanupCheckpointOwner(ckptDirB, ownerIdB);
        expect(reclaimedB.reclaimedLeases).toBe(1);
        expect(existsSync(emptyLeasePath)).toBe(false);

        await expect(reclaimScanCleanupCheckpoint(ckptDirB, entryDirB)).resolves.toBe(true);
        expect(existsSync(entryDirB)).toBe(false);
    });

    it('never unlinks a live successor fresh 0-byte .checkpoint.lock when a contender pauses between lstat and read or enters reclaim on a stale snapshot', async () => {
        const spawnContender = await createContenderWorkerHarness();

        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-s14-fresh-zero-byte-'));
        roots.push(root);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-s14-fresh-zero-byte');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-s14-fresh-zero-byte').digest('hex');
        const witnessA = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-a.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const witnessB = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out-b.pdf'),
                options: {
                    ...baseOptions,
                    crop: true,
                },
            },
            resolvedOptions: {
                ...baseOptions,
                crop: true,
            },
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        // Race 1: Contender 1 pauses after `lstat` on an old lock (>10s old),
        // Contender 2 reclaims it and holds a fresh 0-byte `.checkpoint.lock`
        // right after `open(..., O_CREAT | O_EXCL)`, then Contender 1 resumes.
        const ckptDir1 = join(root, 'ckpt-race-lstat-vs-fresh-zero');
        await mkdir(ckptDir1, {recursive: true});
        const lockPath1 = join(ckptDir1, '.checkpoint.lock');
        await writeFile(lockPath1, JSON.stringify({
            pid: 999_999_999,
            ownerId: 'dead-old-owner',
            token: 'olddeadtoken11111111111111111111',
            acquiredAtMs: Date.now() - 15_000,
        }));
        const oldDate = new Date(Date.now() - 15_000);
        await utimes(lockPath1, oldDate, oldDate);

        const contender1 = spawnContender({
            checkpointDir: ckptDir1,
            sourcePdfPath,
            witness: witnessA,
            ownerId: 'contender-s14-1',
            pauseAtLockLstatHit: 1,
        });
        let contender2: ReturnType<typeof spawnContender> | null = null;
        try {
            // Contender 1 observed the 15s-old `mtimeMs` via `lstat` and paused.
            await contender1.waitFor('afterLockLstat');

            // Contender 2 reclaims the old lock and creates a brand-new 0-byte
            // `.checkpoint.lock`, pausing before writing metadata.
            contender2 = spawnContender({
                checkpointDir: ckptDir1,
                sourcePdfPath,
                witness: witnessB,
                ownerId: 'contender-s14-2',
                pauseAfterLockOpenBeforeWrite: true,
                pauseAtRename: true,
            });
            await contender2.waitFor('afterLockOpenBeforeWrite');

            const freshZeroStatsBefore = await stat(lockPath1);
            expect(freshZeroStatsBefore.size).toBe(0);

            // Resume Contender 1: it reads the fresh 0-byte lock via
            // `readRegularFileNoFollow` and MUST use the fd's fresh `mtimeMs`
            // (not the stale `lstat` mtime), so it never enters reclaim and
            // never unlinks Contender 2's fresh 0-byte lock.
            contender1.release('afterLockLstat');
            await contender1.waitFor('lstatHit-2');

            const freshZeroStatsAfter = await stat(lockPath1);
            expect(freshZeroStatsAfter.dev).toBe(freshZeroStatsBefore.dev);
            expect(freshZeroStatsAfter.ino).toBe(freshZeroStatsBefore.ino);
            expect(freshZeroStatsAfter.size).toBe(0);
            expect(contender1.sawEvent('enteredReclaim')).toBe(false);
            expect(contender1.isDone()).toBe(false);

            // Let Contender 2 finish writing its lock metadata and reach rename.
            contender2.release('afterLockOpenBeforeWrite');
            await contender2.waitFor('atRename');

            const liveLock = JSON.parse(await readFile(lockPath1, 'utf8')) as {
                pid: number;
                ownerId: string;
            };
            expect(liveLock.pid).toBe(process.pid);
            expect(liveLock.ownerId).toBe('contender-s14-2');
            expect(contender1.isDone()).toBe(false);

            // Release Contender 2: both contenders serialize cleanly and complete.
            contender2.release('atRename');
            await Promise.all([
                contender1.done,
                contender2.done,
            ]);
            expect((await readdir(ckptDir1)).filter(name => name.startsWith('.checkpoint.'))).toEqual([]);
        } finally {
            await Promise.all([
                contender1.worker.terminate().catch(() => undefined),
                contender2?.worker.terminate().catch(() => undefined),
            ]);
        }

        // Race 2: Even when a contender already entered `tryReclaimLockFileSerialized`
        // for an old corrupt 0-byte lock (`staleToken === null`), rechecking
        // `currentTarget.mtimeMs` under the exclusive reclaim lock prevents
        // unlinking a live successor's fresh 0-byte lock.
        const ckptDir2 = join(root, 'ckpt-race-reclaim-corrupt-recheck');
        await mkdir(ckptDir2, {recursive: true});
        const lockPath2 = join(ckptDir2, '.checkpoint.lock');
        await writeFile(lockPath2, '');
        await utimes(lockPath2, oldDate, oldDate);

        const contender3 = spawnContender({
            checkpointDir: ckptDir2,
            sourcePdfPath,
            witness: witnessA,
            ownerId: 'contender-s14-3',
            pauseBeforeReclaim: true,
            pauseAtUnlink: true,
        });
        let contender4: ReturnType<typeof spawnContender> | null = null;
        try {
            await contender3.waitFor('beforeStaleLockReclaim');

            // Contender 4 reclaims the old corrupt 0-byte lock and opens a
            // fresh 0-byte `.checkpoint.lock`, pausing before writing metadata.
            contender4 = spawnContender({
                checkpointDir: ckptDir2,
                sourcePdfPath,
                witness: witnessB,
                ownerId: 'contender-s14-4',
                pauseAfterLockOpenBeforeWrite: true,
                pauseAtRename: true,
            });
            await contender4.waitFor('afterLockOpenBeforeWrite');

            const freshStatsBefore2 = await stat(lockPath2);
            expect(freshStatsBefore2.size).toBe(0);

            // Wake Contender 3 so it acquires its reclaim lock and runs the
            // under-reclaim-lock verification against Contender 4's fresh 0-byte lock.
            contender3.release('beforeStaleLockReclaim');
            await contender3.waitFor('beforeStaleLockUnlink');
            contender3.release('beforeStaleLockUnlink');

            await expect.poll(async () => (
                (await readdir(ckptDir2)).filter(name => name.startsWith('.checkpoint.reclaim-')).length
            )).toBe(0);

            const freshStatsAfter2 = await stat(lockPath2);
            expect(freshStatsAfter2.dev).toBe(freshStatsBefore2.dev);
            expect(freshStatsAfter2.ino).toBe(freshStatsBefore2.ino);
            expect(freshStatsAfter2.size).toBe(0);
            expect(contender3.isDone()).toBe(false);

            contender4.release('afterLockOpenBeforeWrite');
            await contender4.waitFor('atRename');
            expect(contender3.isDone()).toBe(false);

            contender4.release('atRename');
            await Promise.all([
                contender3.done,
                contender4.done,
            ]);
            expect((await readdir(ckptDir2)).filter(name => name.startsWith('.checkpoint.'))).toEqual([]);
        } finally {
            await Promise.all([
                contender3.worker.terminate().catch(() => undefined),
                contender4?.worker.terminate().catch(() => undefined),
            ]);
        }
    });

    it('rechecks corrupt-lock age under the exclusive reclaim lock even when (dev, ino) and sha256 are unchanged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-s14-same-inode-age-'));
        roots.push(root);
        const ckptDir = join(root, 'checkpoints');
        await mkdir(ckptDir, {recursive: true});

        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-s14-same-inode');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-s14-same-inode').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });

        // Plant a 0-byte `.checkpoint.lock` backdated past the corrupt grace window.
        const lockPath = join(ckptDir, '.checkpoint.lock');
        await writeFile(lockPath, '');
        const staleDate = new Date(Date.now() - 15_000);
        await utimes(lockPath, staleDate, staleDate);
        const initialStats = await stat(lockPath);
        expect(initialStats.size).toBe(0);

        let beforeUnlinkCalls = 0;
        let observedReclaimFile = '';

        // Once the contender observes the stale 0-byte file and acquires the
        // exclusive reclaim lock, refresh `mtimeMs` in place on the EXACT SAME
        // `(dev, ino)` and identical empty bytes (`sha256`). Only the
        // `isLockMetadataReclaimable(null, currentTarget.mtimeMs)` check under
        // the reclaim lock can prevent unlinking the lock.
        await expect(openScanCleanupConversionCheckpoint({
            checkpointDir: ckptDir,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            ownerId: 'same-inode-age-contender',
            lockTimeoutMs: 60,
            log: () => undefined,
            fileSystem: {
                beforeStaleLockUnlink: async info => {
                    beforeUnlinkCalls += 1;
                    observedReclaimFile = info.reclaimFileName;
                    expect(info.staleToken).toBeNull();
                    const freshNow = new Date();
                    await utimes(lockPath, freshNow, freshNow);
                },
            },
        })).rejects.toThrow(/Timed out waiting for scan cleanup checkpoint lock/u);

        expect(beforeUnlinkCalls).toBe(1);
        expect(observedReclaimFile).toBe(
            `.checkpoint.reclaim-corrupt-${String(initialStats.dev)}-${String(initialStats.ino)}`,
        );

        // The exact same `(dev, ino)` 0-byte lock survived intact and the
        // reclaim lock was cleaned up.
        const survivingStats = await stat(lockPath);
        expect(survivingStats.dev).toBe(initialStats.dev);
        expect(survivingStats.ino).toBe(initialStats.ino);
        expect(survivingStats.size).toBe(0);
        expect((await readdir(ckptDir)).filter(name => name.startsWith('.checkpoint.reclaim-'))).toEqual([]);
    });

    it('preserves previously committed page and batch generations if a replacement commit fails during manifest rename', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-cr5-cr9-generations-'));
        roots.push(root);
        const checkpointDir = join(root, 'checkpoints');
        const scratchV1 = join(root, 'scratch-v1');
        const scratchV2 = join(root, 'scratch-v2');
        const restoreScratch = join(root, 'restore');
        await Promise.all([
            mkdir(scratchV1, {recursive: true}),
            mkdir(scratchV2, {recursive: true}),
            mkdir(restoreScratch, {recursive: true}),
        ]);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-generations');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-generations').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const planSignature = computeScanCleanupRenderPlanSignature({
            documentCanvas: null,
            rasterFormat: 'ppm',
            pages: [],
        });

        let failManifestRename = false;
        const handle = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'streaming',
            log: () => undefined,
            fileSystem: {
                rename: async (oldPath, newPath) => {
                    if (failManifestRename && String(newPath).endsWith('checkpoint.json')) {
                        throw Object.assign(new Error('Simulated replacement manifest rename failure'), {code: 'EIO'});
                    }
                    await rename(oldPath, newPath);
                },
            },
        });

        const writePageSet = async (dir: string, payloadText: string) => {
            const pMeta = join(dir, 'clean-1-page.json');
            const oMeta = join(dir, 'clean-1-0.json');
            const oPng = join(dir, 'clean-1-0.png');
            await writeFile(pMeta, JSON.stringify(pageMetadata()));
            await writeFile(oMeta, JSON.stringify(outputMetadata()));
            await writeFile(oPng, payloadText);
            return [
                {
                    scratchPath: pMeta,
                    fileName: 'clean-1-page.json',
                },
                {
                    scratchPath: oMeta,
                    fileName: 'clean-1-0.json',
                },
                {
                    scratchPath: oPng,
                    fileName: 'clean-1-0.png',
                },
            ];
        };

        // 1. Commit v1 page artifacts, then fail a v2 replacement commit on manifest rename.
        await handle.commitCompletedPages([{
            pageNumber: 1,
            artifacts: await writePageSet(scratchV1, 'generation-v1-png-payload'),
        }], planSignature);

        failManifestRename = true;
        await expect(handle.commitCompletedPages([{
            pageNumber: 1,
            artifacts: await writePageSet(scratchV2, 'generation-v2-png-payload'),
        }], planSignature)).rejects.toThrow('Simulated replacement manifest rename failure');

        // v1 artifacts must still restore cleanly with v1 bytes intact!
        failManifestRename = false;
        const restoredPages = await handle.restoreCompletedPages(restoreScratch, [1], planSignature);
        expect([...restoredPages]).toEqual([1]);
        expect(await readFile(join(restoreScratch, 'clean-1-0.png'), 'utf8')).toBe('generation-v1-png-payload');

        // 2. Commit v1 batch checkpoint (0-output empty batch for clean schema),
        // then fail a v2 replacement batch commit on manifest rename.
        const batchSigV1 = 'b'.repeat(64);
        await handle.commitCompletedBatch({
            batchIndex: 0,
            firstPageNumber: 1,
            batchSignature: batchSigV1,
            batchPdfPath: null,
            summary: {
                inputPages: 1,
                outputPages: 0,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 1,
                blankPagesSkipped: 0,
                accessibilityTagsRemoved: false,
                warnings: ['v1-warning'],
            },
            representationReport: null,
            provenanceStamp: null,
            sourceTextPages: [],
            skippedNonAffine: [],
        });

        failManifestRename = true;
        await expect(handle.commitCompletedBatch({
            batchIndex: 0,
            firstPageNumber: 1,
            batchSignature: batchSigV1,
            batchPdfPath: null,
            summary: {
                inputPages: 1,
                outputPages: 0,
                spreadsSplit: 0,
                offcutsDiscarded: 0,
                deskewSkipped: 0,
                cropSkipped: 0,
                excludedPages: 1,
                blankPagesSkipped: 0,
                accessibilityTagsRemoved: false,
                warnings: ['v2-warning'],
            },
            representationReport: null,
            provenanceStamp: null,
            sourceTextPages: [],
            skippedNonAffine: [],
        })).rejects.toThrow('Simulated replacement manifest rename failure');

        // v1 batch state must remain intact and restorable!
        failManifestRename = false;
        const restoredBatch = await handle.restoreCompletedBatch(0, batchSigV1, [1], join(restoreScratch, 'batch-0.pdf'));
        expect(restoredBatch?.summary.warnings).toEqual(['v1-warning']);
        await handle.complete();
    });

    it('rejects bilevelWritten checkpoint pages missing their PBM artifact and always releases leases on complete() failure', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-cr14-cr22-'));
        roots.push(root);
        const checkpointDir = join(root, 'checkpoints');
        const scratch = join(root, 'scratch');
        const restoreScratch = join(root, 'restore');
        await Promise.all([
            mkdir(scratch, {recursive: true}),
            mkdir(restoreScratch, {recursive: true}),
        ]);
        const sourcePdfPath = join(root, 'source.pdf');
        await writeFile(sourcePdfPath, '%PDF-1.7-cr14-cr22');
        const sourceSha256 = createHash('sha256').update('%PDF-1.7-cr14-cr22').digest('hex');
        const witness = computeScanCleanupCheckpointWitness({
            sourceSha256,
            request: {
                sourcePdfPath,
                outputPdfPath: join(root, 'out.pdf'),
                options: baseOptions,
            },
            resolvedOptions: baseOptions,
            pageScope: [1],
            documentPageCount: 1,
            documentCanvas: null,
            losslessRun: false,
        });
        const planSignature = computeScanCleanupRenderPlanSignature({
            documentCanvas: null,
            rasterFormat: 'ppm',
            pages: [],
        });

        const handle = await openScanCleanupConversionCheckpoint({
            checkpointDir,
            sourcePdfPath,
            witness,
            documentPageCount: 1,
            mode: 'batch',
            ownerId: 'cr22-owner',
            lockTimeoutMs: 40,
            log: () => undefined,
        });
        const pageMetaPath = join(scratch, 'clean-1-page.json');
        const outMetaPath = join(scratch, 'clean-1-0.json');
        await writeFile(pageMetaPath, JSON.stringify(pageMetadata()));
        await writeFile(outMetaPath, JSON.stringify({
            ...outputMetadata(),
            bilevelWritten: true,
        }));
        await handle.commitCompletedPages([{
            pageNumber: 1,
            artifacts: [
                {
                    scratchPath: pageMetaPath,
                    fileName: 'clean-1-page.json',
                },
                {
                    scratchPath: outMetaPath,
                    fileName: 'clean-1-0.json',
                },
            ],
        }], planSignature);

        // CR-14: restoreCompletedPages must reject a page claiming bilevelWritten: true without its .pbm.
        const restored = await handle.restoreCompletedPages(restoreScratch, [1], planSignature);
        expect(restored.size).toBe(0);

        // CR-22: block .checkpoint.lock with a live lock so complete() fails on lock timeout;
        // complete() MUST still release its own active entry lease in finally!
        const liveLockPath = join(checkpointDir, '.checkpoint.lock');
        await writeFile(liveLockPath, JSON.stringify({
            pid: process.pid,
            ownerId: 'blocking-live-owner',
            token: 'blockingtoken1111111111111111111',
            acquiredAtMs: Date.now(),
        }));
        await expect(handle.complete()).rejects.toThrow(/Timed out waiting for scan cleanup checkpoint lock/u);
        await rm(liveLockPath, {force: true});

        // Entry must now have zero active leases so reclaimScanCleanupCheckpoint returns true!
        expect((await readdir(handle.entryDir)).filter(name => name.startsWith('.lease-'))).toEqual([]);
        await expect(reclaimScanCleanupCheckpoint(checkpointDir, handle.entryDir)).resolves.toBe(true);
    });

    it('wakes parked producers if estimateItemBytes throws, retains unreclaimed cleanup bytes, marks AggregateError unproven termination, and sums retained outputs across all batch pages', async () => {
        // CR-18: estimateItemBytes throwing inside consumerLoop while producer
        // is parked at maxInFlightPages must NOT deadlock.
        let estimateCalls = 0;
        const page1Produced = Promise.withResolvers<void>();
        await expect(runBoundedRasterProducerConsumer<number, number>({
            items: [1, 2, 3],
            budget: {
                producerConcurrency: 1,
                maxChunkPages: 2,
                maxInFlightPages: 1,
                maxInFlightBytes: 1024 * 1024,
            },
            signal: new AbortController().signal,
            estimateItemBytes: (_item, index) => {
                estimateCalls += 1;
                if (index === 1 && estimateCalls >= 2) {
                    throw new Error('Synthetic estimateItemBytes failure in consumer');
                }
                return 1024;
            },
            produce: async item => {
                if (item === 1) {
                    page1Produced.resolve();
                }
                return {
                    staged: item,
                    actualBytes: 1024,
                };
            },
            consumeChunk: async () => undefined,
            cleanupStaged: async () => undefined,
        })).rejects.toThrow('Synthetic estimateItemBytes failure in consumer');

        // CR-15: cleanupStaged returning unreclaimedBytes + error keeps bytes
        // reserved and surfaces cleanup failure when no primary error occurred.
        await expect(runBoundedRasterProducerConsumer<number, number>({
            items: [1, 2],
            budget: {
                producerConcurrency: 1,
                maxChunkPages: 1,
                maxInFlightPages: 2,
                maxInFlightBytes: 1500,
            },
            signal: new AbortController().signal,
            estimateItemBytes: () => 1000,
            produce: async item => ({
                staged: item,
                actualBytes: 1000,
            }),
            consumeChunk: async () => undefined,
            cleanupStaged: async () => ({
                unreclaimedBytes: 1000,
                error: Object.assign(new Error('EBUSY removing staged raster'), {code: 'EBUSY'}),
            }),
        })).rejects.toThrow('EBUSY removing staged raster');

        // CR-26: when both a producer error and an unproven consumer error occur,
        // the thrown AggregateError itself carries the direct symbol mark as well.
        const consumerStarted = Promise.withResolvers<void>();
        const releaseConsumer = Promise.withResolvers<void>();
        const directMarkRun = runBoundedRasterProducerConsumer<number, number>({
            items: [1, 2],
            budget: {
                producerConcurrency: 1,
                maxChunkPages: 1,
                maxInFlightPages: 2,
                maxInFlightBytes: 1024 * 1024,
            },
            signal: new AbortController().signal,
            estimateItemBytes: () => 1024,
            produce: async item => {
                if (item === 2) {
                    await consumerStarted.promise;
                    throw new Error('concurrent renderer failure');
                }
                return {
                    staged: item,
                    actualBytes: 1024,
                };
            },
            consumeChunk: async () => {
                consumerStarted.resolve();
                await releaseConsumer.promise;
                throw markUnprovenNativeTermination(
                    new Error('unproven sidecar stop'),
                    'pid=77777 unproven termination',
                );
            },
            cleanupStaged: async () => undefined,
        });
        await consumerStarted.promise;
        await new Promise<void>(resolveImmediate => setImmediate(resolveImmediate));
        releaseConsumer.resolve();
        let caughtDirectMark: unknown;
        try {
            await directMarkRun;
        } catch (error) {
            caughtDirectMark = error;
        }
        expect(caughtDirectMark).toBeInstanceOf(AggregateError);
        expect((caughtDirectMark as Record<symbol, unknown>)[Symbol.for('evb.unprovenNativeTermination')])
            .toBe('pid=77777 unproven termination');
        expect(getUnprovenNativeTerminationDetail(caughtDirectMark)).toBe('pid=77777 unproven termination');

        // CR-24: estimateRawRasterBytes bounds input rasters to residentScratchRasterCount
        // while summing retained cleaned output scratch across ALL batch pages.
        const tenPagePlans = Array.from({length: 10}, () => ({
            renderDpi: 150,
            raster: {
                dpi: 150,
                width: 100,
                height: 100,
            },
            renderCopies: 1,
            additionalScratchBytes: 100_000,
        }));
        const boundedTwoInputs = estimateRawRasterBytes(tenPagePlans, 2)!;
        const singleInputOnly = estimateRawRasterBytes([{
            renderDpi: 150,
            raster: {
                dpi: 150,
                width: 100,
                height: 100,
            },
            renderCopies: 1,
            additionalScratchBytes: 0,
        }], 1)!;
        // 2 resident input rasters + 10 * 100,000 bytes of retained batch outputs.
        expect(boundedTwoInputs).toBe(singleInputOnly * 2 + 10 * 100_000);
    });
});
