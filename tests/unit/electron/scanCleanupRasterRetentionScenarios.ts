import {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readdir,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from 'fs/promises';
import {existsSync} from 'fs';
import {tmpdir} from 'os';
import {
    join,
    sep,
} from 'path';
import {
    afterEach,
    expect,
    vi,
} from 'vitest';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewRequest,
} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';

import {atomicReplace} from '@electron/utils/atomicReplace';
import {readScanCleanupFixtureFile} from '@tests/unit/electron/readScanCleanupFixtureFile';
import {materializeScanCleanupPreviewRequest} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {writeScanCleanupDetectionMetadata as writeDetectionMetadata} from '@tests/unit/electron/writeScanCleanupDetectionMetadata';

import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {
    IScanCleanupDetectionSubscriber,
    IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';

import {configureMainJobBroker} from '@electron/resources/jobBroker';

configureMainJobBroker({
    logicalCpus: 11,
    totalRamBytes: 32 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

// pdftoppm rasterizes the same pixels whichever container it is asked for, so
// the fake renderers write one deterministic pattern in either format.
function rasterPixels(width: number, height: number) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
        pixels[index * 3] = index % 251;
        pixels[index * 3 + 1] = (index * 7) % 253;
        pixels[index * 3 + 2] = (index * 13) % 257 % 256;
    }
    return pixels;
}

function ppmWithDimensions(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'),
        rasterPixels(width, height),
    ]);
}

const dirs: string[] = [];
interface ICapturedPreviewManifest {
    operation: string;
    documentCanvas?: {
        widthPoints: number;
        heightPoints: number;
    };
    pages: Array<{options: {
        sourceDpi: number;
        dpi: number;
    }}>;
}

function isCapturedPreviewManifest(value: unknown): value is ICapturedPreviewManifest {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as {
        operation?: unknown;
        pages?: unknown;
    };
    return typeof candidate.operation === 'string' && Array.isArray(candidate.pages);
}

const request: IScanCleanupPreviewRequest = {
    ownerId: 'preview-owner',
    documentRevision: 'revision-1',
    requestId: requireRequestId('preview-request-1'),
    sourcePdfPath: '/document.pdf',
    pageNumber: requirePageNumber(1),
    options: {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: {
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        },
        despeckle: true,
        skipBlankPages: false,
        pageOverrides: {},
    },
};
const detectionRequest: IScanCleanupDetectionRequest = {
    ownerId: request.ownerId,
    documentRevision: request.documentRevision,
    sourcePdfPath: request.sourcePdfPath,
    options: request.options,
};

function sender(id = 1) {
    return {
        id,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } satisfies IScanCleanupDetectionSubscriber;
}

// Cancellation is a result rather than a rejection on this service, so a test
// that expects a rendered preview says so once instead of narrowing everywhere.
function previewOf(
    service: IScanCleanupPreviewService,
    subscriber: IScanCleanupDetectionSubscriber,
    previewRequest: IScanCleanupPreviewRequest,
) {
    const pending = (async () => {
        const result = await service.preview(subscriber, previewRequest);
        // Cancellation is reported to the renderer as a result; a test that
        // asked for a rendered preview still wants to see it as the abort it is.
        if (result.canceled === true) throw new DOMException('Canceled scan cleanup preview', 'AbortError');
        return result;
    })();
    // The service holds its own handler on the underlying run, so this derived
    // promise carries one too: a test attaches its assertion a turn later.
    void pending.catch(() => undefined);
    return pending;
}

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-test-'));
    dirs.push(dir);
    return dir;
}

// The paper rectangle the source pages carry. A cropped output may extend past
// it by the requested margins, but matching keeps this document rectangle and
// fits the complete padded output inside it.
const DOCUMENT_PAGE_SIZES = [
    1,
    2,
    3,
].map(pageNumber => ({
    pageNumber,
    xPoints: 0,
    yPoints: 0,
    widthPoints: 612,
    heightPoints: 792,
    rotation: 0,
}));
// The same rectangle on the grid a 150 DPI preview renders it at.
const SETTLED_SINGLE_LAYOUT_BY_PAGE = {
    '1': 'single-uncut-page',
    '2': 'single-uncut-page',
    '3': 'single-uncut-page',
} as const;

function dependencies(dir: string): IScanCleanupPreviewDependencies {
    return {
        fileSystem: {
            copyFile,
            mkdir,
            mkdtemp,
            open,
            readFile: readScanCleanupFixtureFile,
            readdir,
            rm,
            stat,
            writeFile,
        },
        getAvailableScratchBytes: async () => Number.MAX_SAFE_INTEGER,
        resolveRasterAdmissionPolicy: () => ({
            rasterConcurrency: 2,
            rasterStreaming: false,
        }),
        acquirePreviewLease: async () => ({release: () => true}),
        getSourceStatIdentity: async () => 'fixture-source',
        resolveQpdfBinary: () => '/usr/bin/qpdf',
        getPageCount: vi.fn(async () => 3),
        getPageSizes: vi.fn(async () => DOCUMENT_PAGE_SIZES),
        publishRaster: atomicReplace,
        // pdftoppm names its own output by dropping the extension and adding
        // the format's, so a caller that asks for anything else gets nothing.
        renderPage: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(`${outputPath.replace(/\.png$/u, '')}.png`, PNG);
        }),
        renderPagePpm: vi.fn(async (_paths, _log, _page, _source, outputPath, _dpi, _env, _signal, crop) => {
            await writeFile(
                `${outputPath.replace(/\.ppm$/u, '')}.ppm`,
                ppmWithDimensions(crop?.width ?? 1, crop?.height ?? 1),
            );
        }),
        runSidecar: vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                options: {outputMode: 'auto' | 'bw' | 'mixed' | 'grayscale' | 'color'};
                outputs: Array<{
                    outputPath: string;
                    metadataPath: string
                }>
            }>};
            const page = manifest.pages[0]!;
            const output = page.outputs[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                detectedSkewDegrees: 0.4,
                skewConfidence: 2.4,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                recommendedOutputMode: 'mixed',
                recommendedOutputModeConfidence: 0.92,
                recommendedOutputModeReason: 'text-with-pictures',
            }));
            await writeFile(output.outputPath, PNG);
            await writeFile(output.metadataPath, JSON.stringify({
                canvasScope: 'page',
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                detectedSkewDegrees: 0.4,
                skewConfidence: 2.4,
                skewApplied: true,
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1,
                    heightPx: 1,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1,
                    heightPx: 1,
                },
                contentDiagnostics: {
                    sideConfidence: {
                        left: 0.7,
                        top: 0.6,
                        right: 0.8,
                        bottom: 0.5,
                    },
                    textMask: {
                        analysisWidthPx: 1,
                        analysisHeightPx: 1,
                        inkPixels: 1,
                        lineCount: 1,
                        bounds: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 1,
                            heightPx: 1,
                        },
                    },
                    acceptedTrims: [{
                        side: 'top',
                        iteration: 1,
                        score: 0.9,
                        threshold: 0.4,
                        contentDistanceSum: 90,
                        garbageDistanceSum: 10,
                        removedBlocks: [{
                            bounds: {
                                xPx: 0,
                                yPx: 0,
                                widthPx: 1,
                                heightPx: 1,
                            },
                            pictureMaskOverlapPixels: 0,
                            headingEvidence: false,
                            grayscaleEvidence: false,
                        }],
                    }],
                    protectedBlocks: [{
                        bounds: {
                            xPx: 0,
                            yPx: 0,
                            widthPx: 1,
                            heightPx: 1,
                        },
                        pictureMaskOverlapPixels: 1,
                        headingEvidence: true,
                        grayscaleEvidence: false,
                    }],
                },
                textToneDiagnostics: {
                    applied: true,
                    rule: 'applied',
                    textLineCount: 24,
                    textInkPixels: 12_400,
                    pictureFraction: 0,
                    outsideMidtoneFraction: 0.04,
                    outsideMidtoneLargestComponentFraction: 0.002,
                    outsideMidtoneLargestComponentWidthFraction: 0.9,
                    outsideMidtoneLargestComponentHeightFraction: 0.01,
                    inkAnchor: 133,
                    blackPoint: 96.05263157894737,
                    slope: 1.623931623931624,
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
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
                outputMode: page.options.outputMode === 'auto' ? 'mixed' : page.options.outputMode,
                illuminationNormalized: true,
                despeckleFallback: true,
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                inverseTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                warnings: [],
            }));
        }),
        resolveBinary: () => '/cleanup',
        resolvePageOpsBinary: () => '/page-ops',
        getTempDir: () => dir,
        mainJobScratch: {using: async (_prefix, run) => {
            const scratch = await mkdtemp(join(dir, 'scan-cleanup-preview-'));
            try {
                return await run(scratch);
            } finally {
                await rm(scratch, {
                    force: true,
                    recursive: true,
                });
            }
        }},
        nativeAllowedPathRoot: dir,
        open,
        stat,
        readFile: readScanCleanupFixtureFile,
        getPdftoppmBinary: () => '/pdftoppm',
        materializeWorkingCopy: vi.fn(async sourcePdfPath => ({
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: sourcePdfPath,
            sourceFingerprint: '',
        })),
        materializeRequest: materializeScanCleanupPreviewRequest,
    };
}

async function previewDependencies() {
    const dir = await setup();
    const deps = dependencies(dir);
    return {
        dir,
        deps,
    };
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

export async function scenarioDoesNotReadTheFullRetainedPNGWhenAProcessingRasterIsPathOnly(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set([1]),
        sourceDpiByPage: new Map([[
            1,
            300,
        ]]),
    }));
    let processingPath: string | undefined;
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        const manifest = JSON.parse(await readFile(args[1], 'utf8')) as {pages: Array<{inputPath: string}>};
        processingPath = manifest.pages[0]?.inputPath;
        await originalSidecar(...args);
    });
    {
        const service = scanCleanupPreviewLifecycle(deps);
        await previewOf(service, sender(), {
            ...request,
            layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
            layoutDetectionComplete: true,
        });
        const retainedProcessingPath = processingPath;
        expect(retainedProcessingPath).toMatch(/page-1-300\.png$/u);
        await rm(retainedProcessingPath!);
        vi.mocked(deps.readFile!).mockClear();

        const rerendered = await previewOf(service, sender(), {
            ...request,
            requestId: requireRequestId('path-only-repeat'),
            layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
            layoutDetectionComplete: true,
        });

        expect(rerendered).toMatchObject({
            pageNumber: 1,
            outputs: [{metadata: expect.any(Object)}],
        });
        expect(vi.mocked(deps.renderPage).mock.calls.map(call => call[5])).toEqual([
            150,
            300,
            300,
        ]);
        expect(processingPath).toBe(retainedProcessingPath);
        await expect(stat(retainedProcessingPath!)).resolves.toMatchObject({size: PNG.byteLength});
        expect(vi.mocked(deps.readFile!).mock.calls.some(([path]) => path === retainedProcessingPath)).toBe(false);
    }

}

export async function scenarioSurfacesACorruptRetainedPathOnlyRasterWithoutSilentlyRerenderingIt(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set([1]),
        sourceDpiByPage: new Map([[
            1,
            300,
        ]]),
    }));
    let processingPath: string | undefined;
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        const manifest = JSON.parse(await readFile(args[1], 'utf8')) as {pages: Array<{inputPath: string}>};
        processingPath = manifest.pages[0]?.inputPath;
        await originalSidecar(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    await previewOf(service, sender(), {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        layoutDetectionComplete: true,
    });
    expect(processingPath).toMatch(/page-1-300\.png$/u);
    await truncate(processingPath!, 8);
    const renderCallsBeforeRetry = vi.mocked(deps.renderPage).mock.calls.length;
    vi.mocked(deps.readFile!).mockClear();

    {
        await expect(previewOf(service, sender(), {
            ...request,
            requestId: requireRequestId('path-only-corrupt-repeat'),
            layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
            layoutDetectionComplete: true,
        })).rejects.toThrow();

        expect(deps.renderPage).toHaveBeenCalledTimes(renderCallsBeforeRetry);
        expect(vi.mocked(deps.readFile!).mock.calls.some(([path]) => path === processingPath)).toBe(false);
    }

}

export async function scenarioRemovesAPathOnlyRasterCanceledAfterRenderingAndBeforeRetention(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set([1]),
        sourceDpiByPage: new Map([[
            1,
            300,
        ]]),
    }));
    const previewSender = sender();
    let canceled = false;
    let canceledScratchPath: string | undefined;
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        args[1]('debug', 'path-only render completed');
        await originalRenderPage(...args);
        if (args[5] === 300) {
            canceledScratchPath = args[4];
            canceled = service.cancel(previewSender, {
                ...request,
                invalidateRawCache: false,
            });
        }
    });
    const service: IScanCleanupPreviewService = scanCleanupPreviewLifecycle(deps);

    await expect(service.preview(previewSender, {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        layoutDetectionComplete: true,
    })).resolves.toEqual({canceled: true});

    expect(canceled).toBe(true);
    expect(canceledScratchPath).toBeDefined();
    await vi.waitFor(async () => {
        await expect(stat(canceledScratchPath!)).rejects.toMatchObject({code: 'ENOENT'});
    });

}

export async function scenarioNeverUnlinksAnAdoptedRasterHoweverOftenItsSlotIsGivenBack(): Promise<void> {

    const dir = await setup();
    const retention = scanCleanupRasterRetention(dependencies(dir));
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
        // What detection's bounded window does for one page: render into a
        // private scratch file, then publish it at the page's stable path.
    const stagePageOne = async () => {
        const scratchPath = await retention.rasterScratchPath(document, 1, 150);
        await writeFile(scratchPath, PNG);
        return retention.retain({
            document,
            dpi: 150,
            height: 1,
            pageNumber: 1,
            scratchPath,
            sizeBytes: PNG.byteLength,
            width: 1,
        });
    };
    const staged = await stagePageOne();
    expect(staged.path).toBe(await retention.stagedRasterPath(document, 1, 150));
    // A preview adopts that exact file: from here it is named in a manifest
    // of its own and fed to a sidecar, so it belongs to that consumer.
    expect(await retention.readPath(document, 1, 150)).toMatchObject({path: staged.path});

    // The window gives the slot back more than once -- a retried eviction,
    // then the rollback that drops whatever it still had admitted -- and
    // the file the other consumer is reading survives every one of them.
    await retention.releaseRaster(document, 1, 150);
    await retention.releaseRaster(document, 1, 150);
    await retention.releaseRaster(document, 1, 150);
    expect(existsSync(staged.path)).toBe(true);
    expect([...(await retention.retainedPaths(document, [1], 150)).keys()]).toEqual([1]);

    // Republishing the page is what returns it to the window: the raster at
    // that path is the one this render produced, so the next release drops
    // it exactly as an unadopted page would be dropped.
    await stagePageOne();
    await retention.releaseRaster(document, 1, 150);
    expect(existsSync(staged.path)).toBe(false);
    expect((await retention.retainedPaths(document, [1], 150)).size).toBe(0);
    await retention.dispose();

}

export async function scenarioServesRasterPageReadsFromAForkedPageSizeStoreWithoutTouchingTheParentCursor(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const pageSizes = [
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            dominantImageWidthPx: 1_275,
            dominantImageHeightPx: 1_650,
            dominantImageWidthPoints: 306,
            dominantImageHeightPoints: 396,
        },
        DOCUMENT_PAGE_SIZES[1]!,
    ];
    const createStore = (): IPdfPageSizeStore => ({
        pageCount: pageSizes.length,
        getPage: vi.fn(async pageNumber => pageSizes[pageNumber - 1]!),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
            pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
        forEachChunk: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    });
    const parent = createStore();
    const forkedStore = createStore();
    const store: IPdfPageSizeStore = {
        ...parent,
        fork: vi.fn(() => forkedStore),
    };
    deps.getPageSizeStore = vi.fn(() => store);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('legacy page-size array reader must not be used');
    });
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });

    const rasterSource = await retention.rasterPageSource(document, new AbortController().signal);
    const [
        first,
        second,
    ] = await Promise.all([
        rasterSource.getPageRaster(1),
        rasterSource.getPageRaster(2),
    ]);
    expect(first).toMatchObject({dpi: 300});
    expect(second).toBeUndefined();
    expect(store.fork).toHaveBeenCalledOnce();
    expect(forkedStore.getPage).toHaveBeenCalledTimes(2);
    expect(parent.getPage).not.toHaveBeenCalled();
    await retention.dispose();

}

export async function scenarioSerializesConcurrentRasterPageReadsOnACursorOnlyPageSizeStore(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const pageSizes = [
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            dominantImageWidthPx: 1_275,
            dominantImageHeightPx: 1_650,
            dominantImageWidthPoints: 306,
            dominantImageHeightPoints: 396,
        },
        DOCUMENT_PAGE_SIZES[1]!,
    ];
    const order: string[] = [];
    let releaseFirstRead: (() => void) | undefined;
    const store: IPdfPageSizeStore = {
        pageCount: pageSizes.length,
        getPage: vi.fn(async (pageNumber) => {
            order.push(`start ${pageNumber}`);
            if (pageNumber === 1) {
                await new Promise<void>((resolve) => {
                    releaseFirstRead = resolve;
                });
            }
            order.push(`end ${pageNumber}`);
            return pageSizes[pageNumber - 1]!;
        }),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
            pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
        forEachChunk: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    };
    deps.getPageSizeStore = vi.fn(() => store);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('legacy page-size array reader must not be used');
    });
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });

    const rasterSource = await retention.rasterPageSource(document, new AbortController().signal);
    const reads = Promise.all([
        rasterSource.getPageRaster(1),
        rasterSource.getPageRaster(2),
    ]);
    await vi.waitFor(() => {
        expect(releaseFirstRead).toBeDefined();
    });
    // The second read must not start while the first holds the shared cursor.
    expect(order).toEqual(['start 1']);
    releaseFirstRead!();
    const [
        first,
        second,
    ] = await reads;
    expect(first).toMatchObject({dpi: 300});
    expect(second).toBeUndefined();
    expect(order).toEqual([
        'start 1',
        'end 1',
        'start 2',
        'end 2',
    ]);
    await retention.dispose();

}

export async function scenarioCoalescesSerializedRasterFactsIntoBoundedNativeBatches(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const pageCount = 96;
    const pages = Array.from({length: pageCount}, (_, index) => ({
        ...DOCUMENT_PAGE_SIZES[0]!,
        pageNumber: index + 1,
    }));
    let readTail = Promise.resolve();
    const store: IPdfPageSizeStore = {
        pageCount,
        getPage: vi.fn(pageNumber => {
            const read = readTail.then(() => pages[pageNumber - 1]!);
            readTail = read.then(() => undefined, () => undefined);
            return read;
        }),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) => (
            pages.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)
        )),
        forEachChunk: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        fork: vi.fn(() => store),
    };
    deps.getPageCount = vi.fn(async () => pageCount);
    deps.getPageSizeStore = vi.fn(() => store);
    deps.isRasterDetectionAvailable = () => true;
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set<number>(),
        bilevelLayerPages: new Set<number>(),
        dominantBilevelLayerPages: new Set<number>(),
        backgroundDpiByPage: new Map<number, number>(),
    }));
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
    const rasterSource = await retention.rasterPageSource(document, new AbortController().signal);

    await Promise.all(pages.map(page => Promise.resolve(rasterSource.getPageRaster(page.pageNumber))));

    expect(deps.detectRasterPages).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.detectRasterPages).mock.calls[0]?.[2]).toEqual(
        pages.map(page => page.pageNumber),
    );
    await retention.dispose();

}

export async function scenarioOpensBoundedPageGeometryAndRasterFactsWithoutTheLegacyArrays(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const pageSizes = [
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            dominantImageWidthPx: 1_275,
            dominantImageHeightPx: 1_650,
            dominantImageWidthPoints: 306,
            dominantImageHeightPoints: 396,
        },
        DOCUMENT_PAGE_SIZES[1]!,
    ];
    const close = vi.fn(async () => undefined);
    const store: IPdfPageSizeStore = {
        pageCount: pageSizes.length,
        getPage: vi.fn(async pageNumber => pageSizes[pageNumber - 1]!),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
            pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
        forEachChunk: vi.fn(async onChunk => {
            await onChunk({
                pageCount: pageSizes.length,
                chunkIndex: 0,
                firstPageNumber: 1,
                offset: 0,
                byteLength: 0,
                pages: [...pageSizes],
            });
        }),
        close,
    };
    deps.getPageSizeStore = vi.fn(() => store);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('legacy page-size array reader must not be used');
    });
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });

    const pageSizeStore = await retention.pageSizeStore(document, new AbortController().signal);
    expect(deps.getPageSizeStore).toHaveBeenCalledOnce();
    expect(deps.getPageSizes).not.toHaveBeenCalled();
    expect(await pageSizeStore.getPage(1)).toMatchObject({pageNumber: 1});
    await pageSizeStore.close();

    const rasterSource = await retention.rasterPageSource(document, new AbortController().signal);
    expect(rasterSource.detected).toBe(false);
    expect(await rasterSource.getPageRaster(1)).toMatchObject({
        dpi: 300,
        width: 1_275,
        height: 1_650,
    });
    expect(rasterSource.documentDpi).toBe(300);
    expect(await rasterSource.getPageRaster(2)).toBeUndefined();
    await retention.release(document);
    expect(close).toHaveBeenCalled();
    await retention.dispose();

}

export async function scenarioBoundsSourceDPIMeasurementsWhilePreservingRecentPageValues(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const detectSourceDpi = vi.fn(async (_sourcePdfPath: string, pageNumber: number) => pageNumber);
    deps.detectSourceDpi = detectSourceDpi;
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
    const signal = new AbortController().signal;

    for (let pageNumber = 1; pageNumber <= 300; pageNumber += 1) {
        await retention.sourceDpi(document, pageNumber, signal);
    }
    await retention.sourceDpi(document, 1, signal);

    expect(detectSourceDpi).toHaveBeenCalledTimes(301);
    await retention.release(document);
    await retention.dispose();

}

export async function scenarioPlansABoundedMatchedPreviewFromChunkedGeometryAndPageRasterMetadata(): Promise<void> {

    const dir = await setup();
    const pageSizes = [
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            dominantImageWidthPx: 2_550,
            dominantImageHeightPx: 3_300,
            dominantImageWidthPoints: 612,
            dominantImageHeightPoints: 792,
        },
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            pageNumber: 2,
            widthPoints: 1_224,
            dominantImageWidthPx: 5_100,
            dominantImageHeightPx: 3_300,
            dominantImageWidthPoints: 1_224,
            dominantImageHeightPoints: 792,
        },
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            pageNumber: 3,
            dominantImageWidthPx: 2_550,
            dominantImageHeightPx: 3_300,
            dominantImageWidthPoints: 612,
            dominantImageHeightPoints: 792,
        },
        {
            ...DOCUMENT_PAGE_SIZES[0]!,
            pageNumber: 4,
            widthPoints: 100,
            heightPoints: 100,
            dominantImageWidthPx: 417,
            dominantImageHeightPx: 417,
            dominantImageWidthPoints: 100,
            dominantImageHeightPoints: 100,
        },
    ];
    const stores: IPdfPageSizeStore[] = [];
    const createStore = (): IPdfPageSizeStore => {
        const store: IPdfPageSizeStore = {
            pageCount: pageSizes.length,
            getPage: vi.fn(async pageNumber => pageSizes[pageNumber - 1]!),
            readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
                pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
            forEachChunk: vi.fn(async onChunk => {
                for (const [
                    chunkIndex,
                    page,
                ] of pageSizes.entries()) {
                    await onChunk({
                        pageCount: pageSizes.length,
                        chunkIndex,
                        firstPageNumber: page.pageNumber,
                        offset: chunkIndex,
                        byteLength: 0,
                        pages: [page],
                    });
                }
            }),
            close: vi.fn(async () => undefined),
        };
        stores.push(store);
        return store;
    };
    const deps = dependencies(dir);
    deps.getPageCount = vi.fn(async () => pageSizes.length);
    deps.getPageSizeStore = vi.fn(createStore);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('legacy page-size array reader must not be used');
    });
    // Keep the bounded raster source on its page accessor. With no
    // pdfimages evidence, the matcher must conservatively check every page.
    deps.isRasterDetectionAvailable = () => false;
    let capturedManifest: ICapturedPreviewManifest | undefined;
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        const parsed: unknown = JSON.parse(await readFile(args[1], 'utf8'));
        if (!isCapturedPreviewManifest(parsed)) {
            throw new Error('sidecar manifest has an invalid shape');
        }
        capturedManifest = parsed;
        await originalSidecar(...args);
    });
    const options: IScanCleanupPreviewRequest['options'] = {
        ...request.options,
        preserveOriginalQuality: true,
        pageOverrides: {
            '1': {
                rotationDegrees: 0,
                layoutOverride: 'spread' as const,
                excluded: false,
                manualSplit: null,
            },
            '2': {
                rotationDegrees: 0,
                layoutOverride: 'single' as const,
                excluded: false,
                manualSplit: null,
            },
            '3': {
                rotationDegrees: 0,
                layoutOverride: 'auto' as const,
                excluded: false,
                manualSplit: {
                    xNormalized: 0.5,
                    rotationDegrees: 0,
                },
            },
        },
    };
    const service = scanCleanupPreviewLifecycle(deps);
    const result = await previewOf(service, sender(), {
        ...request,
        options,
        layoutByPage: {
            ...SETTLED_SINGLE_LAYOUT_BY_PAGE,
            '4': 'single-uncut-page',
        },
        layoutDetectionComplete: true,
    });

    expect(result.pageNumber).toBe(1);
    expect(deps.getPageSizeStore).toHaveBeenCalledTimes(2);
    expect(deps.getPageSizes).not.toHaveBeenCalled();
    expect(deps.runSidecar).toHaveBeenCalledOnce();
    expect(capturedManifest?.documentCanvas?.widthPoints).toBe(1_224);
    expect(capturedManifest?.documentCanvas?.heightPoints).toBe(792);
    // Page four is smaller than the shared spread canvas, so matching
    // requires the same rasterized fallback the final lossless run uses.
    expect(capturedManifest?.operation).toBe('render');
    expect(capturedManifest?.pages[0]?.options).toMatchObject({
        dpi: 150,
        sourceDpi: 300,
    });
    expect(stores.every(store => vi.mocked(store.close).mock.calls.length === 1)).toBe(true);
    await service.dispose();

}

export async function scenarioCoalescesFallbackRasterProbesIntoBoundedStreamingWindows(): Promise<void> {

    const dir = await setup();
    const pageSizes = Array.from({length: 1_025}, (_, index) => ({
        ...DOCUMENT_PAGE_SIZES[0]!,
        pageNumber: index + 1,
    }));
    const store: IPdfPageSizeStore = {
        pageCount: pageSizes.length,
        getPage: vi.fn(async pageNumber => pageSizes[pageNumber - 1]!),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
            pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
        forEachChunk: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
    };
    const probeCalls: number[][] = [];
    const deps = dependencies(dir);
    deps.getPageSizeStore = vi.fn(() => store);
    deps.isRasterDetectionAvailable = () => true;
    deps.detectRasterPages = vi.fn(async (
        _sourcePdfPath: string,
        _signal: AbortSignal,
        pageNumbers: readonly number[] = [],
    ) => {
        probeCalls.push([...pageNumbers]);
        return {
            detected: true,
            pages: new Set(pageNumbers),
            sourceDpiByPage: new Map(pageNumbers.map(pageNumber => [
                pageNumber,
                280,
            ] as const)),
        };
    });
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
    const source = await retention.rasterPageSource(document, new AbortController().signal);
    const rasters = await Promise.all(Array.from({length: pageSizes.length}, (_, index) =>
        Promise.resolve(source.getPageRaster(index + 1))));

    expect(rasters.every(raster => raster?.dpi === 280)).toBe(true);
    expect(source.documentDpi).toBe(280);
    expect(probeCalls).toHaveLength(2);
    expect(probeCalls.every(pageNumbers => pageNumbers.length <= 1_024)).toBe(true);
    const probedPages = probeCalls.flat().sort((left, right) => left - right);
    expect(new Set(probedPages).size).toBe(pageSizes.length);
    expect(probedPages).toEqual(pageSizes.map(page => page.pageNumber));
    await retention.release(document);
    await retention.dispose();

}

export async function scenarioKeepsConcurrentRasterPageWindowsIsolatedForACursorOnlyPageSizeStore(): Promise<void> {

    const dir = await setup();
    const pageSizes = [
        1,
        2,
        3,
        4,
    ].map(pageNumber => ({
        ...DOCUMENT_PAGE_SIZES[0]!,
        pageNumber,
        dominantImageWidthPx: pageNumber * 100,
        dominantImageHeightPx: pageNumber * 200,
        dominantImageWidthPoints: pageNumber * 100,
        dominantImageHeightPoints: pageNumber * 200,
    }));
    let currentPageNumber = 0;
    const store: IPdfPageSizeStore = {
        pageCount: pageSizes.length,
        // This models a bounded reader that keeps one mutable current
        // chunk but predates the optional fork() capability. Two windows
        // must not observe whichever page resumed last.
        getPage: vi.fn(async pageNumber => {
            currentPageNumber = pageNumber;
            await Promise.resolve();
            return pageSizes[currentPageNumber - 1]!;
        }),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) =>
            pageSizes.slice(firstPageNumber - 1, lastPageNumberExclusive - 1)),
        forEachChunk: vi.fn(async onChunk => {
            await onChunk({
                pageCount: pageSizes.length,
                chunkIndex: 0,
                firstPageNumber: 1,
                offset: 0,
                byteLength: 0,
                pages: pageSizes,
            });
        }),
        close: vi.fn(async () => undefined),
    };
    const deps = dependencies(dir);
    deps.getPageSizeStore = vi.fn(() => store);
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
    const source = await retention.rasterPageSource(document, new AbortController().signal);

    const [
        first,
        last,
    ] = await Promise.all([
        source.getPageRaster(1),
        source.getPageRaster(pageSizes.length),
    ]);

    expect(first).toMatchObject({
        width: 100,
        height: 200,
    });
    expect(last).toMatchObject({
        width: 400,
        height: 800,
    });
    await retention.release(document);
    await retention.dispose();

}

export async function scenarioRefusesAnImplicitAllPageLegacyRasterProbeForMillionPageDocuments(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 1_000_000);
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set([1]),
    }));
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });

    const result = await retention.previewRasterPages(document, new AbortController().signal);

    expect(result.detected).toBe(false);
    expect(result.pages.size).toBe(0);
    expect(deps.detectRasterPages).not.toHaveBeenCalled();
    await retention.release(document);
    await retention.dispose();

}

export async function scenarioRefusesLegacyArrayGeometryForMillionPagePreviews(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 1_000_000);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('legacy page-size array reader must not be used');
    });
    const service = scanCleanupPreviewLifecycle(deps);

    await expect(previewOf(service, sender(), request)).rejects.toThrow(
        'bounded page-size store for large documents',
    );
    expect(deps.getPageSizes).not.toHaveBeenCalled();
    await service.dispose();

}

export async function scenarioStopsProtectingAnAdoptedRasterOnceTheIndexHasForgottenIt(): Promise<void> {

    const dir = await setup();
    const retention = scanCleanupRasterRetention(dependencies(dir));
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    });
    const scratchPath = await retention.rasterScratchPath(document, 2, 150);
    await writeFile(scratchPath, PNG);
    const staged = await retention.retain({
        document,
        dpi: 150,
        height: 1,
        pageNumber: 2,
        scratchPath,
        sizeBytes: PNG.byteLength,
        width: 1,
    });
    expect(await retention.readPath(document, 2, 150)).toMatchObject({path: staged.path});

    // Something outside this index removed the file, so the entry and the
    // adoption that went with it are dropped when the index next looks.
    await rm(staged.path);
    expect((await retention.retainedPaths(document, [2], 150)).size).toBe(0);

    // A stale adoption would make this page permanently unreclaimable: a
    // leftover at its path would survive every release the window makes.
    await writeFile(staged.path, PNG);
    await retention.releaseRaster(document, 2, 150);
    expect(existsSync(staged.path)).toBe(false);
    await retention.dispose();

}

export async function scenarioKeepsAStagedRasterAPreviewAdoptedWhileDetectionRecyclesItsSlot(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const pageCount = 12;
    deps.getPageCount = vi.fn(async () => pageCount);
    deps.getPageSizes = vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
        pageNumber: index + 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
    })));
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    const previewSidecar = deps.runSidecar;
    const pageOneAdopted = Promise.withResolvers<undefined>();
    const pageOneReleased = Promise.withResolvers<undefined>();
    // The await further down is what reports a failed handover; this only
    // stops an early one from being seen as an unhandled rejection before
    // that await exists.
    void pageOneReleased.promise.catch(() => undefined);
    let observedWindow: number | undefined;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress, options) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation: string;
            stagedInputWindow?: number;
            pages: Array<{
                inputPath: string;
                sourcePageIndex: number
            }>;
        };
        if (manifest.operation !== 'analyze') {
            await previewSidecar(binary, manifestPath, signal, log, onProgress, options);
            return;
        }
        // Recorded rather than asserted here: an assertion that throws
        // inside the fake sidecar would leave the test awaiting a handover
        // that can no longer happen, reported as a timeout instead of as
        // the window it disagreed with.
        observedWindow = manifest.stagedInputWindow;
        try {
            await writeDetectionMetadata(manifestPath);
            for (const page of manifest.pages) {
                const pageNumber = page.sourcePageIndex + 1;
                onProgress({
                    stage: 'page-input-required',
                    completedPages: 0,
                    totalPages: pageCount,
                    pageNumber,
                });
                await vi.waitFor(() => expect(existsSync(page.inputPath)).toBe(true));
                onProgress({
                    stage: 'page-analyzed',
                    completedPages: pageNumber,
                    totalPages: pageCount,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.8,
                });
                onProgress({
                    stage: 'page-input-released',
                    completedPages: pageNumber,
                    totalPages: pageCount,
                    pageNumber,
                });
                if (pageNumber === 1) {
                    // Hand the run over to a preview of the page detection
                    // just staged, then keep going so the window needs that
                    // slot back.
                    pageOneReleased.resolve(undefined);
                    await pageOneAdopted.promise;
                }
            }
            for (const page of manifest.pages) {
                onProgress({
                    stage: 'page-complete',
                    completedPages: pageCount,
                    totalPages: pageCount,
                    pageNumber: page.sourcePageIndex + 1,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
        } catch (error) {
            // A failure before the handover is a failure the test has to
            // see: without this the analysis dies and the test blocks on a
            // promise nothing will ever settle. Settling it after the
            // handover already happened is a no-op.
            pageOneReleased.reject(error);
            throw error;
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    // Renders of page 1 only: detection keeps staging later pages while the
    // preview runs, and those are not what this assertion is about.
    const pageOneRenders = () => vi.mocked(deps.renderPage).mock.calls
        .filter(call => call[2] === 1).length;
    await pageOneReleased.promise;
    let adopted: string[] = [];
    try {
        const renderedBeforePreview = pageOneRenders();
        // Detection staged page 1, so the comparison below is about a page
        // that was rendered once and must not be rendered again.
        expect(renderedBeforePreview).toBe(1);
        await previewOf(service, sender(), request);
        // The preview read the raster detection staged rather than making one.
        expect(pageOneRenders()).toBe(renderedBeforePreview);
        adopted = (await readdir(dir, {recursive: true}))
            .filter(entry => entry.endsWith(`${sep}page-1-150.png`));
        expect(adopted).toHaveLength(1);
    } finally {
        // The sidecar is parked on this promise, so a failure above has to
        // let the run finish rather than strand it until the test times out.
        pageOneAdopted.resolve(undefined);
    }

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));

    // The whole point of the run: detection staged a window narrower than
    // the document rather than every page at once.
    expect(observedWindow).toBeDefined();
    expect(observedWindow!).toBeLessThan(pageCount);
    // Detection recycled that slot for later pages, but the file stays:
    // a preview named it in a manifest of its own.
    expect((await readdir(dir, {recursive: true}))
        .filter(entry => entry.endsWith(`${sep}page-1-150.png`))).toEqual(adopted);

}

export async function scenarioKeepsARasterItsSidecarIsReadingWhenTheSamePageIsRetainedAgain(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 2);
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    // Preview and detection both reach page 1 while neither has retained
    // it yet, so both render it and both publish it under the same key.
    const bothRendering = Promise.withResolvers<undefined>();
    let coldRenders = 0;
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        if (args[2] === 1) {
            coldRenders += 1;
            if (coldRenders >= 2) bothRendering.resolve(undefined);
            await bothRendering.promise;
        }
        await originalRenderPage(...args);
    });
    // Neither sidecar opens its manifest until both rasters have been
    // published, which is exactly when one used to unlink the other's.
    const bothPublished = Promise.withResolvers<undefined>();
    let entered = 0;
    const readable: Record<string, boolean> = {};
    const originalSidecar = deps.runSidecar;
    const allExist = async (paths: readonly string[]) => {
        const found = await Promise.all(paths.map(async path => {
            try {
                await stat(path);
                return true;
            } catch {
                return false;
            }
        }));
        return found.every(Boolean);
    };
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{inputPath: string}>};
        const detecting = manifest.pages.length > 1;
        entered += 1;
        if (entered >= 2) bothPublished.resolve(undefined);
        await bothPublished.promise;
        readable[detecting ? 'detection' : 'preview'] = await allExist(
            manifest.pages.map(page => page.inputPath),
        );
        if (!detecting) {
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            return;
        }
        await writeDetectionMetadata(manifestPath);
        for (const pageNumber of [
            1,
            2,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 2,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    const previewed = previewOf(service, owner, request);
    const started = await service.detectAll(owner, detectionRequest);
    await previewed;
    await vi.waitFor(() => expect(
        service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
    ).toBe('completed'));

    expect(coldRenders).toBe(2);
    expect(readable).toEqual({
        detection: true,
        preview: true,
    });

}

export async function scenarioProtectsPageReleaseAcrossOwnerClaimsAndHeldReads(): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const readGate = Promise.withResolvers<Uint8Array>();
    const readStarted = Promise.withResolvers<undefined>();
    const sourceRead = deps.readFile!;
    async function delayedReadFile(path: string): Promise<Uint8Array>;
    async function delayedReadFile(path: string, encoding: 'utf8'): Promise<string>;
    async function delayedReadFile(path: string, encoding?: 'utf8') {
        if (encoding === undefined) {
            readStarted.resolve(undefined);
            await readGate.promise;
        }
        return encoding === 'utf8' ? sourceRead(path, 'utf8') : sourceRead(path);
    }
    deps.readFile = delayedReadFile;
    const retention = scanCleanupRasterRetention(deps);
    const document = await retention.openDocument({
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    }, 'owner-1');
    await retention.openDocument({
        sourcePdfPath: document.sourcePdfPath,
        documentRevision: document.documentRevision,
    }, 'owner-2');
    const scratchPath = await retention.rasterScratchPath(document, 1, 150);
    await writeFile(scratchPath, PNG);
    const retained = await retention.retain({
        document,
        dpi: 150,
        height: 1,
        pageNumber: 1,
        scratchPath,
        sizeBytes: PNG.byteLength,
        width: 1,
    }, 'owner-2');

    await retention.releaseRaster(document, 1, 150, 'owner-1');
    expect(existsSync(retained.path)).toBe(true);
    await retention.release(document, 'owner-1');
    const read = retention.read(document, 1, 150);
    await readStarted.promise;
    await retention.releaseRaster(document, 1, 150, 'owner-2');
    readGate.resolve(PNG);
    await expect(read).resolves.toBeNull();
    expect((await retention.retainedPaths(document, [1], 150)).size).toBe(0);

    await retention.release(document, 'owner-2');
    await retention.dispose();
    expect(existsSync(retained.path)).toBe(false);
}

export async function scenarioPreservesAnotherOwnersRasterWhenPublicationIsCanceled(): Promise<void> {
    const dir = await setup();
    const deps = dependencies(dir);
    const originalPublish = deps.publishRaster;
    const publicationWritten = Promise.withResolvers<undefined>();
    const publicationContinue = Promise.withResolvers<undefined>();
    let holdPublication = false;
    deps.publishRaster = async (...args: Parameters<typeof originalPublish>) => {
        await originalPublish(...args);
        if (holdPublication) {
            publicationWritten.resolve(undefined);
            await publicationContinue.promise;
        }
    };
    const retention = scanCleanupRasterRetention(deps);
    const sourcePdfPath = join(dir, 'source.pdf');
    const documentRequest = {
        sourcePdfPath,
        documentRevision: 'revision-1',
    };
    const ownerTwo = await retention.openDocument(documentRequest, 'owner-2');
    const ownerTwoScratch = await retention.rasterScratchPath(ownerTwo, 1, 150);
    await writeFile(ownerTwoScratch, PNG);
    const ownerTwoRaster = await retention.retain({
        document: ownerTwo,
        dpi: 150,
        height: 1,
        pageNumber: 1,
        scratchPath: ownerTwoScratch,
        sizeBytes: PNG.byteLength,
        width: 1,
    }, 'owner-2');
    const ownerOne = await retention.openDocument(documentRequest, 'owner-1');
    const ownerOneScratch = await retention.rasterScratchPath(ownerOne, 1, 150);
    await writeFile(ownerOneScratch, PNG);
    holdPublication = true;
    const ownerOnePublication = retention.retain({
        document: ownerOne,
        dpi: 150,
        height: 1,
        pageNumber: 1,
        scratchPath: ownerOneScratch,
        sizeBytes: PNG.byteLength,
        width: 1,
    }, 'owner-1');

    await publicationWritten.promise;
    retention.invalidate(sourcePdfPath, 'revision-1', 'owner-1');
    publicationContinue.resolve(undefined);
    await expect(ownerOnePublication).rejects.toMatchObject({name: 'AbortError'});

    // The late publication fence is reclaimed after settlement. The same
    // owner identity can claim the current raster again through the public API.
    const recycledOwnerOne = await retention.openDocument(documentRequest, 'owner-1');
    expect(retention.claimRaster(recycledOwnerOne, 1, 150, 'owner-1')).toBe(true);
    await retention.releaseRaster(recycledOwnerOne, 1, 150, 'owner-1');
    await retention.release(recycledOwnerOne, 'owner-1');

    expect(existsSync(ownerOneScratch)).toBe(false);
    expect(existsSync(ownerTwoRaster.path)).toBe(true);
    expect(await retention.retainedPaths(ownerTwo, [1], 150)).toEqual(
        new Map([[
            1,
            ownerTwoRaster,
        ]]),
    );
    expect(retention.claimRaster(ownerTwo, 1, 150, 'owner-2')).toBe(true);
    expect(await retention.readPath(ownerTwo, 1, 150)).toMatchObject({path: ownerTwoRaster.path});
    await expect(readFile(ownerTwoRaster.path)).resolves.toEqual(Buffer.from(PNG));

    await retention.releaseRaster(ownerTwo, 1, 150, 'owner-2');
    await retention.release(ownerTwo, 'owner-2');
    await retention.dispose();
    expect(existsSync(ownerTwoRaster.path)).toBe(false);
}

async function scenarioReleasesClaimAfterExceptionalRetainedRead(
    mode: 'bytes' | 'metadata',
): Promise<void> {
    const dir = await setup();
    const deps = dependencies(dir);
    const retention = scanCleanupRasterRetention(deps);
    const documentRequest = {
        sourcePdfPath: join(dir, 'source.pdf'),
        documentRevision: 'revision-1',
    };
    const ownerTwo = await retention.openDocument(documentRequest, 'owner-2');
    const scratchPath = await retention.rasterScratchPath(ownerTwo, 1, 150);
    await writeFile(scratchPath, PNG);
    const retained = await retention.retain({
        document: ownerTwo,
        dpi: 150,
        height: 1,
        pageNumber: 1,
        scratchPath,
        sizeBytes: PNG.byteLength,
        width: 1,
    }, 'owner-2');
    const ownerOne = await retention.openDocument(documentRequest, 'owner-1');
    const failure = new Error(`forced retained ${mode} read failure`);

    if (mode === 'bytes') {
        const sourceRead = deps.fileSystem?.readFile ?? deps.readFile;
        if (sourceRead === undefined) throw new Error('fixture readFile is unavailable');
        const readFile = sourceRead;
        async function throwingReadFile(path: string): Promise<Uint8Array>;
        async function throwingReadFile(path: string, encoding: 'utf8'): Promise<string>;
        async function throwingReadFile(path: string, encoding?: 'utf8') {
            if (path === retained.path && encoding === undefined) throw failure;
            return encoding === 'utf8' ? readFile(path, 'utf8') : readFile(path);
        }
        deps.readFile = throwingReadFile;
    } else {
        const sourceOpen = deps.open;
        if (sourceOpen === undefined) throw new Error('fixture open is unavailable');
        deps.open = async (path, flags) => {
            if (path === retained.path) throw failure;
            return sourceOpen(path, flags);
        };
    }

    const releaseEvents: string[] = [];
    const releaseRaster = retention.releaseRaster;
    retention.releaseRaster = async (...args: Parameters<typeof releaseRaster>) => {
        if (args[0] === ownerOne) releaseEvents.push('raster');
        return releaseRaster(...args);
    };
    const releaseDocument = retention.release;
    retention.release = async (...args: Parameters<typeof releaseDocument>) => {
        if (args[0] === ownerOne) releaseEvents.push('document');
        return releaseDocument(...args);
    };

    const exceptionalRead = mode === 'bytes'
        ? retention.materializeRawRaster(
            ownerOne,
            1,
            new AbortController().signal,
            deps,
            1,
            150,
            undefined,
            'owner-1',
        )
        : retention.materializeRawRasterPath(
            ownerOne,
            1,
            new AbortController().signal,
            deps,
            1,
            150,
            undefined,
            'owner-1',
        );
    await expect(exceptionalRead).rejects.toBe(failure);

    // The first failed materialization has settled its read lifecycle and
    // released its claim before the document release. Owner two can still
    // inspect and release the raster.
    await retention.release(ownerOne, 'owner-1');
    expect(releaseEvents).toEqual([
        'raster',
        'document',
    ]);
    expect(await retention.retainedPaths(ownerTwo, [1], 150)).toEqual(
        new Map([[
            1,
            retained,
        ]]),
    );
    expect(existsSync(retained.path)).toBe(true);
    await retention.releaseRaster(ownerTwo, 1, 150, 'owner-2');
    await retention.release(ownerTwo, 'owner-2');
    await retention.dispose();
    expect(existsSync(retained.path)).toBe(false);
}

export async function scenarioReleasesClaimAfterExceptionalRetainedByteRead(): Promise<void> {
    await scenarioReleasesClaimAfterExceptionalRetainedRead('bytes');
}

export async function scenarioReleasesClaimAfterExceptionalRetainedMetadataRead(): Promise<void> {
    await scenarioReleasesClaimAfterExceptionalRetainedRead('metadata');
}
