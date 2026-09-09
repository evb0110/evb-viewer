import {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'fs/promises';

import {EventEmitter} from 'node:events';
import {tmpdir} from 'os';
import {join} from 'path';
import {
    afterEach,
    expect,
    vi,
} from 'vitest';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewRequest,
} from '@contracts/electronApiScanCleanup';
import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';

import {resolveScanCleanupPlacementOffset} from '@contracts/scanCleanupPageOverrides';

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

import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {
    resolveScanCleanupPreviewRasterAdmissionPolicy as resolveScanCleanupRasterAdmissionPolicy,
    SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {
    configureMainJobBroker,
    mainJobBroker,
} from '@electron/resources/jobBroker';

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

class LifecycleSender extends EventEmitter {
    readonly id: number;
    destroyed = false;
    readonly isDestroyed = () => this.destroyed;
    readonly send = vi.fn();

    constructor(id: number) {
        super();
        this.id = id;
    }
}

function isScanCleanupDetectionSubscriber(sender: LifecycleSender): sender is LifecycleSender & IScanCleanupDetectionSubscriber {
    return typeof sender.id === 'number'
        && typeof sender.isDestroyed === 'function'
        && typeof sender.send === 'function'
        && typeof sender.on === 'function'
        && typeof sender.once === 'function'
        && typeof sender.removeListener === 'function';
}

function lifecycleSender(id = 100): LifecycleSender & IScanCleanupDetectionSubscriber {
    const sender = new LifecycleSender(id);
    if (!isScanCleanupDetectionSubscriber(sender)) {
        throw new Error('test lifecycle sender is incomplete');
    }
    return sender;
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

async function waitForRelease(release: Promise<unknown>, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, {once: true});
        void release.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, reject);
    });
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
const PREVIEW_DPI = 150;
const DOCUMENT_CANVAS = {
    widthPoints: 612,
    heightPoints: 792,
    widthPx: Math.floor(612 / 72 * PREVIEW_DPI),
    heightPx: Math.floor(792 / 72 * PREVIEW_DPI),
};
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
        resolveRasterAdmissionPolicy: supportsRasterStreaming => resolveScanCleanupRasterAdmissionPolicy(
            mainJobBroker.getSnapshot().capacity,
            supportsRasterStreaming,
        ),
        acquirePreviewLease: (ownerId, visibility, signal) => mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-preview',
            priority: visibility === 'prefetch' ? 'background' : 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
                nativeProcesses: 1,
                ioWeight: 1,
            },
            signal,
        }),
        acquireDetectionLease: (ownerId, signal, policy) => mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-detect-all',
            priority: 'user',
            resources: {
                cpuTokens: policy.rasterConcurrency,
                estimatedResidentBytes: policy.rasterConcurrency * SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
                nativeProcesses: policy.rasterConcurrency + Number(policy.rasterStreaming),
                ioWeight: 2,
            },
            perOwnerLimit: 1,
            signal,
        }),
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
        open,
        stat,
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

async function previewFixture() {
    const dir = await setup();
    const deps = dependencies(dir);
    const service = scanCleanupPreviewLifecycle(deps);
    return {
        dir,
        deps,
        service,
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

async function runTrustedMrcPreview(outputMode: 'auto' | 'bw', outputModeRecommendation: 'mixed' | undefined): Promise<void> {
    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => ({
        detected: true,
        pages: new Set([1]),
        bilevelLayerPages: new Set([1]),
        backgroundDpiByPage: new Map([[
            1,
            100,
        ]]),
    }));
    deps.extractMrcLayers = vi.fn(async (
        _sourcePdfPath,
        _pageNumber,
        selectionMaskOutputPath,
        backgroundOutputPath,
    ) => {
        const foregroundPath = `${backgroundOutputPath}.foreground.jp2`;
        await Promise.all([
            writeFile(selectionMaskOutputPath, PNG),
            writeFile(backgroundOutputPath, PNG),
            writeFile(foregroundPath, 'JP2-SOURCE'),
        ]);
        return {
            backgroundDpi: 100,
            backgroundPath: backgroundOutputPath,
            foregroundDpi: 600,
            foregroundHeight: 2_800,
            foregroundPath,
            foregroundWidth: 2_000,
            selectionMaskDecode: 'default' as const,
            selectionMaskPath: selectionMaskOutputPath,
        };
    });
    const originalSidecar = deps.runSidecar;
    let trustedPaths: {
        trustedForegroundMaskPath?: string;
        trustedMrcBackgroundPath?: string
    } | null = null;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            trustedForegroundMaskPath?: string;
            trustedMrcBackgroundPath?: string
        }>};
        trustedPaths = manifest.pages[0] ?? null;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(scanCleanupPreviewLifecycle(deps), sender(), {
        ...request,
        options: {
            ...request.options,
            outputMode,
        },
        ...(outputModeRecommendation === undefined
            ? {}
            : {outputModeRecommendation}),
    });

    expect(deps.extractMrcLayers).toHaveBeenCalledTimes(1);
    expect(trustedPaths).toMatchObject({
        trustedForegroundMaskPath: expect.stringMatching(/source-mrc-selection\.png$/u),
        trustedMrcBackgroundPath: expect.stringMatching(/source-mrc-background\.png$/u),
    });
}

async function runCanvasCacheOrderPreview(lossless: boolean): Promise<void> {
    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 2);
    const originalSidecar = deps.runSidecar;
    const previewManifests: Array<{
        canvasScope: string;
        documentCanvas?: unknown
    }> = [];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation: string;
            canvasScope: string;
            documentCanvas?: {
                widthPoints: number;
                heightPoints: number
            };
            pages: Array<{
                sourcePageIndex: number;
                pageMetadataPath: string;
                outputs: Array<{
                    outputPath: string;
                    metadataPath: string
                }>;
            }>;
        };
        if (manifest.pages.length === 2) {
            for (const page of manifest.pages) {
                const pageNumber = page.sourcePageIndex + 1;
                const widthPx = pageNumber === 1 ? 60 : 100;
                const heightPx = pageNumber === 1 ? 120 : 140;
                const sourceRegion = {
                    xPx: 0,
                    yPx: 0,
                    widthPx,
                    heightPx,
                };
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    canvasScope: 'page',
                    layoutClassification: 'single-uncut-page',
                    layoutConfidence: 0.9,
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                    outputs: [{
                        half: 'full',
                        sourceRegion,
                        contentBox: null,
                        cropRect: sourceRegion,
                        appliedMargins: {
                            leftPx: 0,
                            topPx: 0,
                            rightPx: 0,
                            bottomPx: 0,
                        },
                        inputWidthPx: widthPx,
                        inputHeightPx: heightPx,
                    }],
                }));
                onProgress({
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 2,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
            return;
        }
        previewManifests.push({
            canvasScope: manifest.canvasScope,
            documentCanvas: manifest.documentCanvas,
        });
        const page = manifest.pages[0]!;
        const intrinsicWidth = page.sourcePageIndex === 0 ? 60 : 100;
        const intrinsicHeight = page.sourcePageIndex === 0 ? 120 : 140;
        if (lossless) {
            await writeFile(page.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                outputs: [{
                    half: 'full',
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: intrinsicWidth,
                        heightPx: intrinsicHeight,
                    },
                    contentBox: null,
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: intrinsicWidth,
                        heightPx: intrinsicHeight,
                    },
                    appliedMargins: {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    },
                    inputWidthPx: intrinsicWidth,
                    inputHeightPx: intrinsicHeight,
                }],
            }));
            return;
        }
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
        const output = page.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx: intrinsicWidth,
            outputHeightPx: intrinsicHeight,
            canvasWidthPx: 100,
            canvasHeightPx: 140,
            matchedCanvasTargetWidthPx: 100,
            matchedCanvasTargetHeightPx: 140,
            canvasPolicy: 'strict-maximum',
        }));
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const detectRequest = {
        ...detectionRequest,
        options: {
            ...detectionRequest.options,
            preserveOriginalQuality: lossless,
        },
    };
    const started = await service.detectAll(owner, detectRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectRequest,
    )?.status).toBe('completed'));

    const second = await previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        options: detectRequest.options,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
    const first = await previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(1),
        options: detectRequest.options,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });

    // The raster path reads the canvas the sidecar wrote; the lossless path
    // places the analysed crop on the same document rectangle itself.
    const matchedCanvas = lossless
        ? {
            canvasWidthPx: DOCUMENT_CANVAS.widthPx,
            canvasHeightPx: DOCUMENT_CANVAS.heightPx,
        }
        : {
            canvasWidthPx: 100,
            canvasHeightPx: 140,
        };
    expect([
        first.outputs[0]?.metadata,
        second.outputs[0]?.metadata,
    ]).toEqual([
        expect.objectContaining({
            ...matchedCanvas,
            canvasScope: 'page',
        }),
        expect.objectContaining({
            ...matchedCanvas,
            canvasScope: 'page',
        }),
    ]);
    expect(previewManifests).toEqual([
        {
            canvasScope: 'page',
            documentCanvas: DOCUMENT_CANVAS,
        },
        {
            canvasScope: 'page',
            documentCanvas: DOCUMENT_CANVAS,
        },
    ]);

    if (lossless) {
        // This is the preserveOriginalQuality row in the harness table:
        // preview reports the same free-space offset that the lossless PDF
        // assembler consumes, with pixel flooring only at the metadata
        // boundary. A sign or rounding mutation makes this identity red.
        for (const output of [
            first.outputs[0]!.metadata,
            second.outputs[0]!.metadata,
        ]) {
            const contentWidthPx = output.matchedCanvasContentWidthPx!;
            const contentHeightPx = output.matchedCanvasContentHeightPx!;
            const innerWidthPx = output.canvasWidthPx
                    - output.appliedMargins.leftPx
                    - output.appliedMargins.rightPx;
            const innerHeightPx = output.canvasHeightPx
                    - output.appliedMargins.topPx
                    - output.appliedMargins.bottomPx;
            const exportPlacement = resolveScanCleanupPlacementOffset(
                innerWidthPx - contentWidthPx,
                innerHeightPx - contentHeightPx,
                detectRequest.options.pageAlignment,
            );
            expect({
                previewX: output.placementOffsetXPx - output.appliedMargins.leftPx,
                previewY: output.placementOffsetYPx - output.appliedMargins.topPx,
                exportX: Math.floor(exportPlacement.x),
                exportY: Math.floor(exportPlacement.y),
            }).toEqual({
                previewX: Math.floor(exportPlacement.x),
                previewY: Math.floor(exportPlacement.y),
                exportX: Math.floor(exportPlacement.x),
                exportY: Math.floor(exportPlacement.y),
            });
        }
    }
}

async function runRendererCancellation(eventName: 'destroyed' | 'render-process-gone'): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const releaseLease = vi.fn(() => true);
    deps.acquirePreviewLease = vi.fn(async () => ({release: releaseLease}));
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal) => {
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    const pending = previewOf(service, owner, request);
    await entered.promise;

    expect(owner.listenerCount('destroyed')).toBe(1);
    expect(owner.listenerCount('render-process-gone')).toBe(1);
    owner.emit(eventName);

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(owner.listenerCount('render-process-gone')).toBe(0);
    await service.dispose();
    await expect(readdir(dir)).resolves.toHaveLength(0);
}

export async function scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const releasePrefetch = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(releasePrefetch.promise, args[7]!);
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const prefetch = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await entered.promise;
    const visible = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });

    // The visible page does not queue behind the neighbour's raster.
    await expect(visible).resolves.toMatchObject({pageNumber: 1});
    releasePrefetch.resolve(undefined);
    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});

}

export async function scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        entered.resolve(undefined);
        await release.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const prefetch = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await entered.promise;
    const navigatedTo = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });

    release.resolve(undefined);
    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
    await expect(navigatedTo).resolves.toMatchObject({pageNumber: 2});
    expect(deps.renderPage).toHaveBeenCalledOnce();
    expect(deps.runSidecar).toHaveBeenCalledOnce();

}

export async function scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'bw',
    });
    await entered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'color',
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({
        pageNumber: 1,
        outputs: [{metadata: {outputMode: 'color'}}],
    });
    expect(deps.renderPage).toHaveBeenCalledTimes(2);

}

export async function scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await entered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered: Array<Promise<undefined>> = [];
    const enteredPages = new Map<number, PromiseWithResolvers<undefined>>();
    deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, _outputPath, _dpi, _env, signal) => {
        enteredPages.get(pageNumber)?.resolve(undefined);
        await waitForRelease(Promise.withResolvers<never>().promise, signal!);
    });
    for (const pageNumber of [
        1,
        2,
        3,
    ]) {
        const resolvers = Promise.withResolvers<undefined>();
        enteredPages.set(pageNumber, resolvers);
        entered.push(resolvers.promise);
    }
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pages = [
        1,
        2,
        3,
    ].map(pageNumber => previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(pageNumber),
    }));
    await Promise.all(entered);

    expect(service.cancel(previewSender, {
        ...request,
        invalidateRawCache: false,
        retainPages: [
            2,
            3,
        ],
    })).toBe(true);

    await expect(pages[0]).rejects.toMatchObject({name: 'AbortError'});
    expect(await Promise.race([
        pages[1]!.then(() => 'settled', () => 'settled'),
        Promise.resolve('pending'),
    ])).toBe('pending');
    expect(service.cancel(previewSender, request)).toBe(true);
    await expect(pages[1]).rejects.toMatchObject({name: 'AbortError'});
    await expect(pages[2]).rejects.toMatchObject({name: 'AbortError'});

}

export async function scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.renderPage = vi.fn(async (_paths, _log, _page, _source, _outputPath, _dpi, _env, signal) => {
        entered.resolve(undefined);
        await waitForRelease(Promise.withResolvers<never>().promise, signal!);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const raw = previewOf(service, previewSender, {
        ...request,
        visible: true,
    });
    await entered.promise;

    service.cancel(previewSender, {
        ...request,
        invalidateRawCache: false,
        retainPages: [1],
    });
    expect(await Promise.race([
        raw.then(() => 'settled', () => 'settled'),
        Promise.resolve('pending'),
    ])).toBe('pending');

    expect(service.cancel(previewSender, request)).toBe(true);
    await expect(raw).rejects.toMatchObject({name: 'AbortError'});

}

export async function scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectSourceDpi = vi.fn(async () => 300);
    const baseRenderEntered = Promise.withResolvers<undefined>();
    const releaseBaseRender = Promise.withResolvers<undefined>();
    const originalSidecar = deps.runSidecar;
    let sidecarCalls = 0;
    const pendingBaseSignals: AbortSignal[] = [];
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        sidecarCalls += 1;
        if (sidecarCalls === 2) {
            pendingBaseSignals.push(args[2]);
            baseRenderEntered.resolve(undefined);
            await waitForRelease(releaseBaseRender.promise, args[2]);
        }
        await originalSidecar(...args);
    });
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        if (args[5] !== 150) {
            throw new Error('detail lane executed');
        }
        await originalRenderPage(...args);
    });
    deps.renderPagePpm = vi.fn(async () => {
        throw new Error('detail lane executed');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();

    await previewOf(service, previewSender, request);
    const pendingBase = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });
    await baseRenderEntered.promise;
    const detail = previewOf(service, previewSender, {
        ...request,
        detail: {
            viewports: {full: {
                xNormalized: 0.25,
                yNormalized: 0.2,
                widthNormalized: 0.5,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    });

    await expect(detail).rejects.toThrow('detail lane executed');
    expect(pendingBaseSignals[0]?.aborted).toBe(false);
    releaseBaseRender.resolve(undefined);
    await expect(pendingBase).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const rasterEntered = Promise.withResolvers<undefined>();
    const releaseRaster = Promise.withResolvers<undefined>();
    let renderCalls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renderCalls += 1;
        if (renderCalls === 1) {
            rasterEntered.resolve(undefined);
            await releaseRaster.promise;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pending = previewOf(service, previewSender, request);
    await rasterEntered.promise;

    expect(service.cancel(previewSender, request)).toBe(true);
    releaseRaster.resolve(undefined);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});

    expect(deps.renderPage).toHaveBeenCalledTimes(2);

}

export async function scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    const sidecarEntered = Promise.withResolvers<undefined>();
    const releaseSidecar = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        sidecarEntered.resolve(undefined);
        await releaseSidecar.promise;
        await originalSidecar(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pending = previewOf(service, previewSender, request);
    await sidecarEntered.promise;

    expect(service.cancel(previewSender, request)).toBe(true);
    releaseSidecar.resolve(undefined);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(previewOf(service, previewSender, {
        ...request,
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
    })).rejects.toThrow('detail geometry is unavailable');

    expect(deps.runSidecar).toHaveBeenCalledOnce();

}

export async function scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const staleEntered = Promise.withResolvers<undefined>();
    const currentEntered = Promise.withResolvers<undefined>();
    const releaseCurrent = Promise.withResolvers<undefined>();
    const currentSignals: AbortSignal[] = [];
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        const signal = args[7]!;
        if (args[3] === request.sourcePdfPath) {
            staleEntered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, signal);
            return;
        }
        currentSignals.push(signal);
        currentEntered.resolve(undefined);
        await waitForRelease(releaseCurrent.promise, signal);
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await staleEntered.promise;
    const currentRequest = {
        ...request,
        sourcePdfPath: '/replacement.pdf',
    };
    const current = previewOf(service, previewSender, currentRequest);
    await currentEntered.promise;

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    expect(service.cancel(previewSender, request)).toBe(false);
    expect(currentSignals[0]?.aborted).toBe(false);
    releaseCurrent.resolve(undefined);
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const staleEntered = Promise.withResolvers<undefined>();
    let renderCalls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renderCalls += 1;
        if (renderCalls === 1) {
            staleEntered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await staleEntered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        documentRevision: 'revision-2',
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated(): Promise<void> {

    const {

        deps,
        service,
    } = await previewFixture();

    await previewOf(service, sender(), request);
    service.cancel(sender(), {
        ...request,
        invalidateRawCache: false,
    });
    await previewOf(service, sender(), {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });

    expect(deps.renderPage).toHaveBeenCalledOnce();
    expect(deps.runSidecar).toHaveBeenCalledTimes(2);

    service.cancel(sender(), request);
    await previewOf(service, sender(), {
        ...request,
        options: {
            ...request.options,
            thickness: 2,
        },
    });
    expect(deps.renderPage).toHaveBeenCalledTimes(2);

}

export async function scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.runSidecar = vi.fn(async () => {
        throw new Error('invalid cleaned preview');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();

    await expect(previewOf(service, previewSender, {
        ...request,
        visible: true,
    })).rejects.toThrow('invalid cleaned preview');
    expect(previewSender.send).toHaveBeenCalledWith(
        SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
        expect.objectContaining({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        }),
    );
    expect(deps.renderPage).toHaveBeenCalledOnce();

}

export async function scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges(): Promise<void> {

    const {

        deps,
        service,
    } = await previewFixture();

    await previewOf(service, sender(), request);
    await previewOf(service, sender(), {
        ...request,
        documentRevision: 'revision-2',
    });

    expect(deps.renderPage).toHaveBeenCalledTimes(2);

}

export async function scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision(): Promise<void> {

    const {deps} = await previewDependencies();
    const statIdentities = [
        '100:1000',
        '100:1000',
        '100:2000',
    ];
    deps.getSourceStatIdentity = vi.fn(async () => statIdentities.shift() ?? '100:2000');
    const service = scanCleanupPreviewLifecycle(deps);

    await previewOf(service, sender(), request);
    await previewOf(service, sender(), request);
    expect(deps.renderPage).toHaveBeenCalledOnce();

    await previewOf(service, sender(), request);
    expect(deps.renderPage).toHaveBeenCalledTimes(2);

}

export async function scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const firstEntered = Promise.withResolvers<undefined>();
    const secondEntered = Promise.withResolvers<undefined>();
    const releaseSecond = Promise.withResolvers<undefined>();
    let callCount = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        callCount += 1;
        if (callCount === 1) {
            firstEntered.resolve(undefined);
            await new Promise<void>((_resolve, reject) => args[7]?.addEventListener('abort', () => reject(args[7]?.reason), {once: true}));
            return;
        }
        secondEntered.resolve(undefined);
        await releaseSecond.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const firstSender = sender(1);
    const secondSender = sender(2);
    const first = previewOf(service, firstSender, request);
    await firstEntered.promise;
    const second = previewOf(service, secondSender, {
        ...request,
        ownerId: 'preview-owner-2',
    });
    await secondEntered.promise;

    expect(service.cancel(firstSender, request)).toBe(true);
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    releaseSecond.resolve(undefined);
    await expect(second).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const gate = Promise.withResolvers<undefined>();
    let renders = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renders += 1;
        await gate.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const previewWith = (thickness: number) => previewOf(service, owner, {
        ...request,
        options: {
            ...request.options,
            thickness,
        },
    });

    // Three lingering keys for the same page, each superseding the ones
    // before it, and then a replacement that reuses the second key. The
    // lane now holds an older entry carrying the generation a counter taken
    // from the superseded list would hand to the live one.
    const first = previewWith(0);
    const second = previewWith(1);
    const third = previewWith(2);
    const replacement = previewWith(1);
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await expect(second).rejects.toMatchObject({name: 'AbortError'});
    await expect(third).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(renders).toBe(1));

    // The retired generation must not have taken the live replacement out
    // of the registry with it: an identical request adopts the run in
    // flight instead of starting a second render of the same page.
    const adopting = previewWith(1);
    await new Promise(resolve => {
        setTimeout(resolve, 0);
    });
    expect(renders).toBe(1);
    gate.resolve(undefined);
    await expect(replacement).resolves.toMatchObject({pageNumber: 1});
    await expect(adopting).resolves.toMatchObject({pageNumber: 1});
    expect(renders).toBe(1);

}

export async function scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.prefetchLeaseTimeoutMs = 30_000;
    const admissions: Array<{
        visibility: string;
        granted: boolean;
    }> = [];
    const granted = Promise.withResolvers<undefined>();
    // One native process is free, which is what a detection run at
    // capacity-1 leaves behind: a visible request fits, a prefetch does not.
    deps.acquirePreviewLease = vi.fn(async (ownerId, visibility, signal) => {
        expect(ownerId).toBe('scan-cleanup:1:preview-owner');
        const admission = {
            visibility,
            granted: false,
        };
        admissions.push(admission);
        if (visibility === 'prefetch') {
            return new Promise<{release: () => boolean}>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException('aborted', 'AbortError'),
                ), {once: true});
            });
        }
        admission.granted = true;
        granted.resolve(undefined);
        return {release: vi.fn(() => true)};
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    // Page 1 is what the user is looking at, so page 2 is a prefetch.
    await previewOf(service, owner, {
        ...request,
        visible: true,
    });
    const prefetch = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await vi.waitFor(() => expect(admissions).toHaveLength(2));
    // Navigating onto the prefetched page adopts its run, which is then
    // readmitted as the page the user is waiting on rather than left in a
    // queue behind detection.
    const navigated = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        visible: true,
    });
    await granted.promise;

    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
    await expect(navigated).resolves.toMatchObject({pageNumber: 2});
    expect(admissions.map(admission => admission.visibility)).toEqual([
        'visible',
        'prefetch',
        'visible',
    ]);

}

export async function scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.prefetchLeaseTimeoutMs = 20;
    deps.acquirePreviewLease = vi.fn((_ownerId, visibility, signal) => {
        if (visibility === 'prefetch') {
            return new Promise<{release: () => boolean}>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException('aborted', 'AbortError'),
                ), {once: true});
            });
        }
        return Promise.resolve({release: vi.fn(() => true)});
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    await previewOf(service, owner, {
        ...request,
        visible: true,
    });
    const prefetch = service.preview(owner, {
        ...request,
        pageNumber: requirePageNumber(2),
    });

    await expect(prefetch).resolves.toEqual({canceled: true});
    // The dropped run is not adopted by the page turn that follows it: the
    // visible request renders page 2 for itself.
    await expect(previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        visible: true,
    })).resolves.toMatchObject({pageNumber: 2});

}

export async function scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes(): Promise<void> {

    const {deps} = await previewDependencies();
    const materializing = Promise.withResolvers<undefined>();
    const finishMaterializing = Promise.withResolvers<undefined>();
    // Materialization is the one await between the run's abort check and the
    // lease it queues for, so a cancellation that lands here is the one the
    // lease has to see.
    deps.materializeWorkingCopy = vi.fn(async (sourcePdfPath: string) => {
        materializing.resolve(undefined);
        await finishMaterializing.promise;
        return {
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: sourcePdfPath,
            sourceFingerprint: '',
        };
    });
    const acquirePreviewLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.acquirePreviewLease = acquirePreviewLease;
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    const pending = service.preview(owner, {
        ...request,
        visible: true,
    });
    await materializing.promise;
    expect(service.cancel(owner, request)).toBe(true);
    finishMaterializing.resolve(undefined);

    await expect(pending).resolves.toEqual({canceled: true});
    expect(acquirePreviewLease).not.toHaveBeenCalled();

}

export async function scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization(): Promise<void> {

    const {deps} = await previewDependencies();
    const materializing = Promise.withResolvers<undefined>();
    const finishMaterializing = Promise.withResolvers<undefined>();
    deps.materializeWorkingCopy = vi.fn(async () => {
        materializing.resolve(undefined);
        await finishMaterializing.promise;
        throw new Error('Working copy path is not managed by this owner');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    const pending = service.preview(owner, {
        ...request,
        visible: true,
    });
    await materializing.promise;
    expect(service.cancel(owner, request)).toBe(true);
    finishMaterializing.resolve(undefined);

    await expect(pending).resolves.toEqual({canceled: true});

}

export async function scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost(): Promise<void> {

    const {deps} = await previewDependencies();
    const {capacity} = mainJobBroker.getSnapshot();
    deps.getPageCount = vi.fn(async () => 8);
    let liveNatives = 0;
    let peakNatives = 0;
    const trackNative = async <T>(run: () => Promise<T>) => {
        liveNatives += 1;
        peakNatives = Math.max(peakNatives, liveNatives);
        try {
            return await run();
        } finally {
            liveNatives -= 1;
        }
    };
        // Detection parks on the pages the previews never ask for, so its lease
        // is held by exactly `rasterConcurrency` live rasterisers while the page
        // switch arrives.
    const heldDetectionRasters = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn((...args) => trackNative(async () => {
        if (args[2] > 3) await heldDetectionRasters.promise;
        await originalRenderPage(
            args[0],
            args[1],
            args[2],
            args[3],
            args[4],
            args[5],
            args[6],
            args[7],
        );
    }));
    const originalRunSidecar = deps.runSidecar;
    const heldPreviewSidecars = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn((...args) => trackNative(async () => {
        const manifestPath = args[1];
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation: string;
            pages: unknown[];
        };
        if (manifest.operation !== 'analyze') {
            await heldPreviewSidecars.promise;
            await originalRunSidecar(
                args[0],
                args[1],
                args[2],
                args[3],
                args[4],
            );
            return;
        }
        await writeDetectionMetadata(manifestPath);
        for (let pageNumber = 1; pageNumber <= manifest.pages.length; pageNumber += 1) {
            args[4]({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: manifest.pages.length,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    }));
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(liveNatives).toBe(capacity.nativeProcesses - 1));

    const previewPage = (pageNumber: number, visible = false) => previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(pageNumber),
        ...(visible ? {visible: true} : {}),
    });
    const visiblePreview = previewPage(1, true);
    // The page the user navigates onto is served while detection still holds
    // its lease: its raw raster reaches the renderer without waiting for the
    // job, and a whole sidecar run before the cleaned outputs.
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
        SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
        expect.objectContaining({pageNumber: 1}),
    ));
    const prefetched = [
        previewPage(2),
        previewPage(3),
    ];
        // The visible page reaches its sidecar; the two prefetches are scheduled
        // behind the machine rather than added to it.
    await vi.waitFor(() => expect(deps.runSidecar).toHaveBeenCalledTimes(1));
    expect(liveNatives).toBe(capacity.nativeProcesses);
    expect(peakNatives).toBe(capacity.nativeProcesses);
    expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');

    heldPreviewSidecars.resolve(undefined);
    expect((await visiblePreview).pageNumber).toBe(1);
    expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');
    heldDetectionRasters.resolve(undefined);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        request,
    )?.status).toBe('completed'));
    expect((await Promise.all(prefetched)).map(result => result.pageNumber)).toEqual([
        2,
        3,
    ]);
    expect(peakNatives).toBe(capacity.nativeProcesses);

}

export async function scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument(): Promise<void> {

    const {deps} = await previewDependencies();
    const acquire = vi.spyOn(mainJobBroker, 'acquire');
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    await previewOf(service, owner, {
        ...request,
        visible: true,
    });
    await previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
    });

    const priorities = acquire.mock.calls
        .filter(([request_]) => request_.kind === 'scan-cleanup-preview')
        .map(([request_]) => ({
            admissionClass: request_.admissionClass,
            ownerId: request_.ownerId,
            perOwnerLimit: request_.perOwnerLimit,
            priority: request_.priority,
            nativeProcesses: request_.resources.nativeProcesses,
        }));
    expect(priorities).toEqual([
        {
            admissionClass: undefined,
            ownerId: 'scan-cleanup:1:preview-owner',
            perOwnerLimit: undefined,
            priority: 'visible',
            nativeProcesses: 1,
        },
        {
            admissionClass: undefined,
            ownerId: 'scan-cleanup:1:preview-owner',
            perOwnerLimit: undefined,
            priority: 'background',
            nativeProcesses: 1,
        },
    ]);
    acquire.mockRestore();

}

export async function scenarioTrustedMrcAutomaticBwPreview(): Promise<void> {
    await runTrustedMrcPreview('auto', 'mixed');
}

export async function scenarioTrustedMrcExplicitBwPreview(): Promise<void> {
    await runTrustedMrcPreview('bw', undefined);
}

export async function scenarioRasterCanvasCacheOrderIndependence(): Promise<void> {
    await runCanvasCacheOrderPreview(false);
}

export async function scenarioLosslessCanvasCacheOrderIndependence(): Promise<void> {
    await runCanvasCacheOrderPreview(true);
}

export async function scenarioDestroyedInFlightCancellation(): Promise<void> {
    await runRendererCancellation('destroyed');
}

export async function scenarioRenderProcessGoneInFlightCancellation(): Promise<void> {
    await runRendererCancellation('render-process-gone');
}

export async function scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem(): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const owner1 = lifecycleSender(101);
    const owner2 = lifecycleSender(202);
    const stores: Array<{
        store: IPdfPageSizeStore;
        closed: boolean;
        reads: number
    }> = [];
    const handles = new Set<{close: () => Promise<void>}>();
    let activeLeases = 0;
    const detailEntered = Promise.withResolvers<undefined>();
    const detailRelease = Promise.withResolvers<undefined>();
    const detectionEntered = Promise.withResolvers<undefined>();
    const detectionRelease = Promise.withResolvers<undefined>();
    const ownerOneEntered = Promise.withResolvers<undefined>();
    const ownerOneRelease = Promise.withResolvers<undefined>();
    const originalOpen = deps.fileSystem!.open;
    const originalLegacyOpen = deps.open;
    const originalSidecar = deps.runSidecar;
    let ownerOneActive = false;
    let detailMetadataPath: string | undefined;
    let detailRasterPath: string | undefined;
    let detailBasePath: string | undefined;
    let detailResultPath: string | undefined;
    let ownerTwoRasterPath: string | undefined;

    deps.detectSourceDpi = vi.fn(async () => 300);

    deps.getPageSizeStore = async () => {
        const closed = {value: false};
        let reads = 0;
        const assertOpen = () => {
            if (closed.value) throw new Error('page-size store is closed');
        };
        const store: IPdfPageSizeStore = {
            pageCount: DOCUMENT_PAGE_SIZES.length,
            getPage: async pageNumber => {
                assertOpen();
                reads += 1;
                return DOCUMENT_PAGE_SIZES[pageNumber - 1]!;
            },
            readRange: async (first, last) => {
                assertOpen();
                reads += 1;
                return DOCUMENT_PAGE_SIZES.slice(first - 1, last - 1);
            },
            forEachChunk: async onChunk => {
                assertOpen();
                reads += 1;
                await onChunk({
                    chunkIndex: 0,
                    firstPageNumber: 1,
                    pageCount: DOCUMENT_PAGE_SIZES.length,
                    offset: 0,
                    byteLength: DOCUMENT_PAGE_SIZES.length,
                    pages: DOCUMENT_PAGE_SIZES,
                });
            },
            close: async () => {
                closed.value = true;
            },
        };
        stores.push({
            store,
            get closed() { return closed.value; },
            get reads() { return reads; },
        });
        return store;
    };
    const trackHandle = async <T extends {close: () => Promise<void>}>(handle: T) => {
        const close = handle.close.bind(handle);
        let closed = false;
        handles.add(handle);
        handle.close = async () => {
            if (!closed) {
                closed = true;
                handles.delete(handle);
                await close();
            }
        };
        return handle;
    };
    deps.fileSystem = {
        ...deps.fileSystem!,
        open: async (...args) => trackHandle(await originalOpen(...args)),
    };
    deps.open = async (...args) => trackHandle(await originalLegacyOpen!(...args));
    deps.acquirePreviewLease = async (..._args) => {
        activeLeases += 1;
        let released = false;
        return {release: () => {
            if (released) {
                return false;
            }
            released = true;
            activeLeases = Math.max(0, activeLeases - 1);
            return true;
        }};
    };
    deps.acquireDetectionLease = async (..._args) => {
        activeLeases += 1;
        let released = false;
        return {release: () => {
            if (released) {
                return false;
            }
            released = true;
            activeLeases = Math.max(0, activeLeases - 1);
            return true;
        }};
    };
    deps.runSidecar = vi.fn(async (binaryPath, manifestPath, signal, log, onProgress, options) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation?: string;
            pages: Array<{
                inputPath?: string;
                detailRenderPlan?: {
                    baseMetadataPath?: string;
                    baseRasterPath?: string;
                    baseCleanedRasterPath?: string;
                };
                outputs: Array<{outputPath: string}>;
            }>;
        };
        const page = manifest.pages[0]!;
        if (manifest.operation === 'analyze') {
            await writeDetectionMetadata(manifestPath);
            detectionEntered.resolve(undefined);
            await waitForRelease(detectionRelease.promise, signal);
        } else if (ownerOneActive) {
            ownerOneEntered.resolve(undefined);
            await waitForRelease(ownerOneRelease.promise, signal);
        } else if (page.detailRenderPlan !== undefined) {
            const plan = page.detailRenderPlan;
            for (const path of [
                plan.baseMetadataPath,
                plan.baseRasterPath,
                plan.baseCleanedRasterPath,
            ]) {
                if (path !== undefined) {
                    expect(path.startsWith(`${dir}/`)).toBe(true);
                }
            }
            detailMetadataPath = plan.baseMetadataPath;
            detailRasterPath = plan.baseRasterPath;
            detailBasePath = plan.baseCleanedRasterPath;
            detailEntered.resolve(undefined);
            await waitForRelease(detailRelease.promise, signal);
        } else {
            ownerTwoRasterPath = page.inputPath;
        }
        detailResultPath = page.outputs[0]?.outputPath;
        await originalSidecar(binaryPath, manifestPath, signal, log, onProgress, options);
    });

    const service = scanCleanupPreviewLifecycle(deps);
    const composedRequest = {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        layoutDetectionComplete: true,
    };
    await previewOf(service, owner2, composedRequest);
    const detail = previewOf(service, owner2, {
        ...composedRequest,
        requestId: requireRequestId('preview-detail-request'),
        detail: {
            viewports: {full: {
                xNormalized: 0.25,
                yNormalized: 0.2,
                widthNormalized: 0.5,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    });
    await detailEntered.promise;
    ownerOneActive = true;
    const ownerOnePreview = previewOf(service, owner1, {
        ...composedRequest,
        ownerId: 'owner-1',
        pageNumber: requirePageNumber(2),
    });
    await ownerOneEntered.promise;
    expect(service.cancel(owner1, {
        ownerId: 'owner-1',
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    })).toBe(true);
    await expect(ownerOnePreview).rejects.toMatchObject({name: 'AbortError'});
    const detection = await service.detectAll(owner2, detectionRequest);
    await detectionEntered.promise;
    expect(detailBasePath).toBeDefined();
    expect(ownerTwoRasterPath).toBeDefined();
    await expect(stat(ownerTwoRasterPath!)).resolves.toBeDefined();
    await expect(stat(detailMetadataPath!)).resolves.toBeDefined();
    await expect(stat(detailRasterPath!)).resolves.toBeDefined();
    await expect(stat(detailBasePath!)).resolves.toBeDefined();
    const resultStorePaths = (await readdir(dir)).filter(name => name.startsWith('scan-cleanup-results-'));
    expect(resultStorePaths).not.toHaveLength(0);
    expect(stores.some(entry => entry.reads > 0)).toBe(true);
    expect(stores.some(entry => !entry.closed)).toBe(true);
    expect(service.getDetectionJobState(owner2, detection.jobId, detectionRequest)?.status).toBe('running');
    detailRelease.resolve(undefined);
    await expect(detail).resolves.toMatchObject({pageNumber: 1});
    await service.dispose();
    expect(activeLeases).toBe(0);
    expect(handles).toHaveLength(0);
    expect(stores.every(entry => entry.closed)).toBe(true);
    expect(owner1.listenerCount('destroyed')).toBe(0);
    expect(owner1.listenerCount('render-process-gone')).toBe(0);
    expect(owner2.listenerCount('destroyed')).toBe(0);
    expect(owner2.listenerCount('render-process-gone')).toBe(0);
    expect(detailResultPath).toContain(dir);
    await expect(readdir(dir)).resolves.toHaveLength(0);
}
