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

import {EventEmitter} from 'node:events';
import {tmpdir} from 'os';
import {
    join,
    normalize,
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
    TScanCleanupDetectionJobState,
} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';

import {atomicReplace} from '@electron/utils/atomicReplace';
import {readScanCleanupFixtureFile} from '@tests/unit/electron/readScanCleanupFixtureFile';
import {materializeScanCleanupPreviewRequest} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {writeScanCleanupDetectionMetadata as writeDetectionMetadata} from '@tests/unit/electron/writeScanCleanupDetectionMetadata';

import {scanCleanupDetectionOwner} from '@electron/features/scan-cleanup/scanCleanupDetectionLifecycle';
import type {IScanCleanupDetectionOwner} from '@electron/features/scan-cleanup/scanCleanupDetectionLifecycle';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {
    IScanCleanupDetectionSubscriber,
    IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';

import {resolveScanCleanupPreviewRasterAdmissionPolicy as resolveScanCleanupRasterAdmissionPolicy} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';

import {decodeScanCleanupDetectionJobState} from '@contracts/scan-cleanup/ipcResultCodecs';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
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

function createDetectionScenarioOwner(deps: IScanCleanupPreviewDependencies): IScanCleanupDetectionOwner {
    const retention = scanCleanupRasterRetention(deps);
    const owner = scanCleanupDetectionOwner(deps, retention);
    return {
        ...owner,
        async dispose() {
            await owner.dispose();
            await retention.dispose();
        },
    };
}

function pngWithDimensions(width: number, height: number) {
    const png = PNG.slice();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return png;
}

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
const documentPrior = {
    dominantLayout: 'two-page-spread' as const,
    cutterRatioMedian: 0.5,
    clusterDims: {
        widthPx: 1,
        heightPx: 1,
    },
    agreementStrength: 0.8,
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

async function retainedRasterCount(dir: string) {
    const entries = await readdir(dir, {recursive: true});
    return entries.filter(entry => entry.split(sep)[0]?.startsWith('scan-cleanup-rasters-') === true
        && entry.endsWith('.png')).length;
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
        acquirePreviewLease: async () => ({release: () => true}),
        acquireDetectionLease: async () => ({release: () => true}),
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

export async function scenarioPublishesProvisionalPageResultsBeforeDocumentReconciliationCompletes(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const remainingRasters = Promise.withResolvers<undefined>();
    deps.renderPage = vi.fn(async (...args) => {
        if (args[2] > 1) await remainingRasters.promise;
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
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    const analysisEntered = Promise.withResolvers<undefined>();
    const remainingAnalysis = Promise.withResolvers<undefined>();
    const reconciliationEntered = Promise.withResolvers<undefined>();
    const finishReconciliation = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        onProgress({
            stage: 'page-analyzed',
            completedPages: 1,
            totalPages: 3,
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.8,
            reconciled: false,
        });
        analysisEntered.resolve(undefined);
        await remainingAnalysis.promise;
        for (const pageNumber of [
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-analyzed',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.8,
                reconciled: false,
            });
        }
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
        reconciliationEntered.resolve(undefined);
        await finishReconciliation.promise;
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    service.subscribeDetectionJob(owner, started.jobId, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.progress).toMatchObject({
        stage: 'rasterizing',
        completedUnits: 1,
        totalUnits: 3,
    }));
    expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results).toEqual([]);

    remainingRasters.resolve(undefined);
    await analysisEntered.promise;
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.progress).toMatchObject({
        stage: 'detecting',
        completedUnits: 1,
        totalUnits: 3,
    }));
    const analyzing = service.getDetectionJobState(owner, started.jobId, detectionRequest);
    expect(analyzing?.results).toEqual([expect.objectContaining({
        pageNumber: 1,
        classification: 'single-uncut-page',
        confidence: 0.8,
        reconciled: false,
    })]);
    expect(decodeScanCleanupDetectionJobState(analyzing)).toEqual(analyzing);

    remainingAnalysis.resolve(undefined);
    await reconciliationEntered.promise;
    await vi.waitFor(() => expect(owner.send.mock.calls
        .filter(([channel]) => channel
                === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
        .map(([
            _channel,
            state,
        ]) => decodeScanCleanupDetectionJobState(state))
        .flatMap(state => state?.results ?? [])
        .filter(result => result.pageNumber === 1)
        .map(result => result.confidence)).toContain(0.9));
    finishReconciliation.resolve(undefined);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));
    expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)).toMatchObject({
        progress: {
            stage: 'detecting',
            completedUnits: 3,
            totalUnits: 3,
        },
        results: [
            {pageNumber: 1},
            {pageNumber: 2},
            {pageNumber: 3},
        ],
    });
    const streamedPageOneRevisions = owner.send.mock.calls
        .filter(([channel]) => channel
                === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
        .map(([
            _channel,
            state,
        ]) => decodeScanCleanupDetectionJobState(state))
        .flatMap(state => state?.results ?? [])
        .filter(result => result.pageNumber === 1)
        .map(result => result.confidence);
    expect(streamedPageOneRevisions).toContain(0.9);

}

export async function scenarioStagesEveryReplayableDetectionRasterBeforeNativeAnalysisBegins(): Promise<void> {

    const {deps} = await previewDependencies();
    const firstRasterStarted = Promise.withResolvers<undefined>();
    const remainingRasters = Promise.withResolvers<undefined>();
    const rasterOutputPaths = new Map<number, string>();
    const deliveredPageNumbers: number[] = [];
    let activeRasterizers = 0;
    let peakActiveRasterizers = 0;
    deps.createRasterPipes = vi.fn();
    deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
        activeRasterizers += 1;
        peakActiveRasterizers = Math.max(peakActiveRasterizers, activeRasterizers);
        rasterOutputPaths.set(pageNumber, outputPath);
        try {
            if (pageNumber === 1) {
                await writeFile(outputPath, pngWithDimensions(1, 1));
                firstRasterStarted.resolve(undefined);
                return;
            }
            await remainingRasters.promise;
            await writeFile(outputPath, pngWithDimensions(1, 1));
        } finally {
            activeRasterizers -= 1;
        }
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await firstRasterStarted.promise;
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            analysisInputPath?: string;
            analysisDpi?: number;
            inputPath: string;
            sourcePageIndex: number;
        }>};
        expect(manifest.pages.every(page =>
            page.analysisInputPath === undefined && page.analysisDpi === undefined,
        )).toBe(true);
        await writeDetectionMetadata(manifestPath);
        const waitForDelivery = async (page: typeof manifest.pages[number]) => {
            await vi.waitFor(async () => {
                const bytes = await readFile(page.inputPath);
                expect(bytes.byteLength).toBeGreaterThan(0);
            });
            deliveredPageNumbers.push(page.sourcePageIndex + 1);
        };
        await waitForDelivery(manifest.pages[0]!);
        onProgress({
            stage: 'page-analyzed',
            completedPages: 1,
            totalPages: 3,
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.8,
            reconciled: false,
        });
        await remainingRasters.promise;
        for (const pageNumber of [
            2,
            3,
        ]) {
            await waitForDelivery(manifest.pages[pageNumber - 1]!);
            onProgress({
                stage: 'page-analyzed',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.8,
                reconciled: false,
            });
        }
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    remainingRasters.resolve(undefined);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));
    expect(deps.createRasterPipes).not.toHaveBeenCalled();
    expect(peakActiveRasterizers).toBeGreaterThan(1);
    expect(deps.renderPage).toHaveBeenCalledTimes(3);
    expect(deliveredPageNumbers).toEqual([
        1,
        2,
        3,
    ]);
    expect(rasterOutputPaths.size).toBe(3);

}

export async function scenarioRemovesTemporaryDetectionRasterPathsWhenNativeAnalysisFails(): Promise<void> {

    const {deps} = await previewDependencies();
    const stagedPaths: string[] = [];
    deps.createRasterPipes = vi.fn();
    deps.renderPage = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
        stagedPaths.push(outputPath);
        await writeFile(outputPath, pngWithDimensions(1, 1));
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async () => {
        await vi.waitFor(() => expect(stagedPaths.length).toBeGreaterThan(0));
        throw new Error('native consumer failed');
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('failed'));
    await Promise.all(stagedPaths.map(async path => {
        await expect(stat(path)).rejects.toMatchObject({code: 'ENOENT'});
    }));

}

export async function scenarioDoesNotHangWhenDetectionAbortsDuringNativeAnalysis(): Promise<void> {

    const {deps} = await previewDependencies();
    const sidecarEntered = Promise.withResolvers<undefined>();
    const rasterFinished = Promise.withResolvers<undefined>();
    deps.createRasterPipes = vi.fn();
    deps.renderPage = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
        await writeFile(outputPath, pngWithDimensions(1, 1));
        rasterFinished.resolve(undefined);
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal) => {
        sidecarEntered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(signal.reason);
            };
            signal.addEventListener('abort', onAbort, {once: true});
            if (signal.aborted) onAbort();
        });
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await sidecarEntered.promise;
    await rasterFinished.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(service.cancelDetection(owner, started.jobId, detectionRequest)).toBe(true);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('canceled'));
    const stagedPath = vi.mocked(deps.renderPage).mock.calls[0]?.[4];
    expect(stagedPath).toBeDefined();
    await expect(stat(stagedPath!)).rejects.toMatchObject({code: 'ENOENT'});

}

export async function scenarioReconcilesEveryDetectionClassificationAgainstTheWholeDocumentNotAWindowOfIt(): Promise<void> {

    const dir = await setup();
    const totalPages = 8;
    const deps = dependencies(dir);
    deps.getPageCount = vi.fn(async () => totalPages);
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    // Stands in for reconcile_classification_batch: the cluster consensus a
    // page is judged against, and the cutter the sidecar then publishes, are
    // derived from the pages that share its manifest.
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            sourcePageIndex: number;
            pageMetadataPath: string;
        }>};
        await writeDetectionMetadata(manifestPath);
        const reconciledPages = manifest.pages.map(page => page.sourcePageIndex + 1);
        const clusterAgreement = reconciledPages.length / totalPages;
        const cutterXPx = Math.max(...reconciledPages);
        for (const [
            index,
            pageNumber,
        ] of reconciledPages.entries()) {
            onProgress({
                stage: 'page-complete',
                completedPages: index + 1,
                totalPages: reconciledPages.length,
                pageNumber,
                classification: 'two-page-spread',
                confidence: 0.9,
                cutterXPx,
                clusterAgreement,
                documentPrior: {
                    ...documentPrior,
                    agreementStrength: clusterAgreement,
                },
            });
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));

    const results = service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results ?? [];
    expect(results.map(result => result.pageNumber)).toEqual(Array.from(
        {length: totalPages},
        (_value, index) => index + 1,
    ));
    expect([...new Set(results.map(result => result.clusterAgreement))]).toEqual([1]);
    expect([...new Set(results.map(result => result.cutterXPx))]).toEqual([totalPages]);
    expect([...new Set(results.map(result => result.documentPrior?.agreementStrength))]).toEqual([1]);

}

export async function scenarioRasterizesDetectionPagesStraightToDiskInsteadOfBufferingThem(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath) => {
        await writeFile(outputPath, pngWithDimensions(883, 1335));
        // Sparse padding well past what the preview path is willing to hold
        // in memory: detection must never read a rendered page back.
        await truncate(outputPath, 48 * 1024 * 1024);
    });
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));
    expect(service.getDetectionJobState(owner, started.jobId, detectionRequest)?.results).toHaveLength(3);

}

export async function scenarioAnalyzesEveryPageOnTheSameCanonical150DPIGridAsFinalRendering(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map((page, index) => {
        const sourceDpi = [
            100,
            300,
            150,
        ][index]!;
        return {
            ...page,
            dominantImageWidthPx: Math.round(page.widthPoints / 72 * sourceDpi),
            dominantImageHeightPx: Math.round(page.heightPoints / 72 * sourceDpi),
            dominantImageWidthPoints: page.widthPoints,
            dominantImageHeightPoints: page.heightPoints,
        };
    }));
    const renderedDpiByPage = new Map<number, number>();
    deps.renderPage = vi.fn(async (
        _paths,
        _log,
        pageNumber,
        _source,
        outputPath,
        dpi,
    ) => {
        renderedDpiByPage.set(pageNumber, dpi);
        await writeFile(`${outputPath.replace(/\.png$/u, '')}.png`, PNG);
    });
    let manifestDpiByPage = new Map<number, {
        dpi: number;
        sourceDpi: number
        hasSeparateCanonicalInput: boolean;
    }>();
    const hasSeparateCanonicalInput = (page: {
        inputPath: string;
        analysisInputPath?: string;
        analysisDpi?: number;
    }): boolean => page.analysisInputPath !== undefined
            && page.analysisDpi !== undefined
            && normalize(page.analysisInputPath) !== normalize(page.inputPath);
    expect(hasSeparateCanonicalInput({
        inputPath: '/tmp/source.png',
        analysisInputPath: '/tmp/analysis.png',
        analysisDpi: 150,
    })).toBe(true);
    expect(hasSeparateCanonicalInput({
        inputPath: '/tmp/source.png',
        analysisInputPath: '/tmp/./source.png',
        analysisDpi: 150,
    })).toBe(false);
    expect(hasSeparateCanonicalInput({
        inputPath: '/tmp/source.png',
        analysisInputPath: '/tmp/analysis.png',
    })).toBe(false);
    expect(hasSeparateCanonicalInput({
        inputPath: '/tmp/source.png',
        analysisDpi: 150,
    })).toBe(false);
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            options: {
                dpi: number;
                sourceDpi: number
            };
            analysisInputPath?: string;
            analysisDpi?: number;
            inputPath: string;
            sourcePageIndex: number;
        }>};
        manifestDpiByPage = new Map(manifest.pages.map(page => [
            page.sourcePageIndex + 1,
            {
                dpi: page.options.dpi,
                sourceDpi: page.options.sourceDpi,
                hasSeparateCanonicalInput: hasSeparateCanonicalInput(page),
            },
        ]));
        await writeDetectionMetadata(manifestPath);
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });

    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));

    expect(Object.fromEntries(renderedDpiByPage)).toEqual({
        1: 150,
        2: 150,
        3: 150,
    });
    expect(Object.fromEntries(manifestDpiByPage)).toEqual({
        1: {
            dpi: 150,
            sourceDpi: 100,
            hasSeparateCanonicalInput: false,
        },
        2: {
            dpi: 150,
            sourceDpi: 300,
            hasSeparateCanonicalInput: false,
        },
        3: {
            dpi: 150,
            sourceDpi: 150,
            hasSeparateCanonicalInput: false,
        },
    });

}

export async function scenarioPreviewsAPageDetectionRasterizedWithoutARendererAndWithoutASecondPageCount(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        for (const pageNumber of [
            1,
            2,
            3,
        ]) {
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: 3,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));
    expect(deps.renderPage).toHaveBeenCalledTimes(3);
    expect(deps.getPageCount).toHaveBeenCalledOnce();

    const pageRequest = (pageNumber: number, documentRevision = request.documentRevision) => ({
        ...request,
        documentRevision,
        pageNumber: requirePageNumber(pageNumber),
    });
    for (const pageNumber of [
        1,
        2,
        3,
    ]) {
        await expect(previewOf(service, sender(), pageRequest(pageNumber))).resolves.toMatchObject({
            pageNumber,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        });
    }
    // Detection and final Auto analysis share the 150-DPI evidence scale,
    // so the retained detection rasters are also the visible previews.
    expect(deps.renderPage).toHaveBeenCalledTimes(3);
    expect(deps.getPageCount).toHaveBeenCalledOnce();

    await previewOf(service, sender(), pageRequest(1, 'revision-2'));
    expect(deps.renderPage).toHaveBeenCalledTimes(4);
    expect(deps.getPageCount).toHaveBeenCalledTimes(2);

    service.cancel(sender(), {
        ...request,
        documentRevision: 'revision-2',
    });
    await vi.waitFor(async () => expect(await retainedRasterCount(dir)).toBe(0));

}

export async function scenarioStreamsABrokeredDetectAllLifecycleAndHandsItsRastersToLaterPreviewRequests(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    const originalRenderPage = deps.renderPage;
    const rasterGate = Promise.withResolvers<undefined>();
    let detectionRastersEntered = 0;
    let activeRasters = 0;
    let peakRasters = 0;
    deps.renderPage = vi.fn(async (...args) => {
        activeRasters += 1;
        peakRasters = Math.max(peakRasters, activeRasters);
        try {
            if (args[2] > 1) {
                detectionRastersEntered += 1;
                if (detectionRastersEntered === 2) {
                    rasterGate.resolve(undefined);
                }
                await rasterGate.promise;
            }
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
        } finally {
            activeRasters -= 1;
        }
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation?: string;
            analysisPurpose?: string;
            pages: Array<{
                sourcePageIndex: number;
                options: {
                    dpi: number;
                    layout: string
                };
                outputs?: unknown;
            }>;
        };
        if (manifest.operation !== 'analyze') {
            await originalSidecar(binary, manifestPath, signal, log, onProgress);
            return;
        }
        await writeDetectionMetadata(manifestPath);
        expect(manifest.analysisPurpose).toBe('page-plan');
        expect(manifest.pages.every(page => page.options.dpi === 150)).toBe(true);
        expect(manifest.pages.every(page => Array.isArray(page.outputs) && page.outputs.length === 0)).toBe(true);
        expect(manifest.pages[1]?.options.layout).toBe('force-two-page');
        for (const page of manifest.pages) {
            const spread = page.sourcePageIndex <= 1;
            const nativeProgress = {
                stage: 'page-complete',
                completedPages: page.sourcePageIndex + 1,
                pageNumber: page.sourcePageIndex + 1,
                totalPages: manifest.pages.length,
                classification: spread ? 'two-page-spread' : 'single-uncut-page',
                confidence: page.sourcePageIndex === 0 ? 0.86 : page.sourcePageIndex === 1 ? 1 : 0.95,
                ...(spread ? {cutterXPx: 0.5} : {}),
                tier1Verdict: page.sourcePageIndex === 0
                    ? 'single-uncut-page'
                    : spread ? 'two-page-spread' : 'single-uncut-page',
                reconciled: page.sourcePageIndex === 0,
                clusterAgreement: page.sourcePageIndex === 1 ? 0 : 0.8,
                ...(page.sourcePageIndex === 1 ? {} : {documentPrior}),
                ...(page.sourcePageIndex === 0 ? {textAxis: {
                    sideways: true,
                    confidence: 0.98,
                }} : {}),
            } as const;
            onProgress(nativeProgress);
        }
    });
    const service = scanCleanupPreviewLifecycle(deps);
    await previewOf(service, sender(), request);
    const started = await service.detectAll(sender(), {
        ...detectionRequest,
        options: {
            ...detectionRequest.options,
            pageOverrides: {'2': {
                rotationDegrees: 0,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: null,
            }},
        },
    });
    await vi.waitFor(() => expect(service.getDetectionJobState(sender(), started.jobId, request)?.status).toBe('completed'));

    const state = service.getDetectionJobState(sender(), started.jobId, request);
    expect(decodeScanCleanupDetectionJobState(state)).toEqual(state);
    expect(state).toMatchObject({
        status: 'completed',
        progress: {
            stage: 'detecting',
            completedUnits: 3,
            totalUnits: 3,
            percent: 100,
            completedPageNumbers: [
                1,
                2,
                3,
            ],
        },
        results: [
            {
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.86,
                cutterXPx: 0.5,
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.8,
                documentPrior,
                textAxis: {
                    sideways: true,
                    confidence: 0.98,
                },
            },
            {
                pageNumber: 2,
                classification: 'two-page-spread',
                confidence: 1,
                cutterXPx: 0.5,
                tier1Verdict: 'two-page-spread',
                reconciled: false,
                clusterAgreement: 0,
                documentPrior: null,
            },
            {
                pageNumber: 3,
                classification: 'single-uncut-page',
                confidence: 0.95,
                cutterXPx: null,
                tier1Verdict: 'single-uncut-page',
                reconciled: false,
                clusterAgreement: 0.8,
                documentPrior,
            },
        ],
    });
    expect(deps.acquireDetectionLease).toHaveBeenCalledWith(
        'scan-cleanup:1:preview-owner',
        expect.any(AbortSignal),
        expect.objectContaining({
            rasterConcurrency: 4,
            rasterStreaming: false,
        }),
    );
    // The visible page-1 raster is reused by 150-DPI detection; only pages
    // 2 and 3 need additional renders.
    expect(deps.renderPage).toHaveBeenCalledTimes(3);
    expect(peakRasters).toBe(2);

    await previewOf(service, sender(), {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await previewOf(service, sender(), request);
    expect(deps.renderPage).toHaveBeenCalledTimes(3);

}

export async function scenarioRasterizesDetectionPagesAsWideAsThe11CoreHostAllowsAndLeasesThatWidth(): Promise<void> {

    const {deps} = await previewDependencies();
    const acquire = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.acquireDetectionLease = acquire;
    deps.getPageCount = vi.fn(async () => 8);
    const originalRenderPage = deps.renderPage;
    let activeRasters = 0;
    let peakRasters = 0;
    deps.renderPage = vi.fn(async (...args) => {
        activeRasters += 1;
        peakRasters = Math.max(peakRasters, activeRasters);
        try {
            await new Promise(resolve => setTimeout(resolve, 5));
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
        } finally {
            activeRasters -= 1;
        }
    });
    deps.runSidecar = vi.fn(async () => {
        throw new Error('detection stopped once every page was rasterized');
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('failed'));
    expect(deps.renderPage).toHaveBeenCalledTimes(8);
    const policy = resolveScanCleanupRasterAdmissionPolicy(
        mainJobBroker.getSnapshot().capacity,
        false,
    );
    expect(peakRasters).toBe(policy.rasterConcurrency);
    expect(acquire).toHaveBeenCalledWith(
        'scan-cleanup:1:preview-owner',
        expect.any(AbortSignal),
        expect.objectContaining({
            rasterConcurrency: policy.rasterConcurrency,
            rasterStreaming: false,
        }),
    );

}

export async function scenarioIncludesTheClassifierSidecarInStreamingDetectionAdmission(): Promise<void> {

    const {deps} = await previewDependencies();
    const acquire = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.acquireDetectionLease = acquire;
    deps.createRasterPipes = vi.fn(async () => {
        throw new Error('stop after streaming admission');
    });
    deps.runSidecar = vi.fn(async () => {
        throw new Error('stop after non-streaming admission');
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('failed'));
    const policy = resolveScanCleanupRasterAdmissionPolicy(
        mainJobBroker.getSnapshot().capacity,
        process.platform !== 'win32',
    );
    expect(acquire).toHaveBeenCalledWith(
        'scan-cleanup:1:preview-owner',
        expect.any(AbortSignal),
        expect.objectContaining({
            rasterConcurrency: policy.rasterConcurrency,
            rasterStreaming: true,
        }),
    );

}

export async function scenarioFallsBackFromRasterStreamingUntilBrokerCapacityCanAdmitItsSidecar(): Promise<void> {

    const {deps} = await previewDependencies();
    const snapshot = mainJobBroker.getSnapshot();
    const getSnapshot = vi.spyOn(mainJobBroker, 'getSnapshot').mockReturnValue({
        ...snapshot,
        capacity: {
            ...snapshot.capacity,
            nativeProcesses: 1,
        },
    });
    deps.createRasterPipes = vi.fn(async () => {
        throw new Error('raster pipes must stay disabled at bootstrap capacity');
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async () => {
        throw new Error('stop after non-streaming fallback');
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('failed'));
    expect(deps.acquireDetectionLease).toHaveBeenCalledWith(
        'scan-cleanup:1:preview-owner',
        expect.any(AbortSignal),
        {
            rasterConcurrency: 1,
            rasterStreaming: false,
        },
    );
    expect(deps.createRasterPipes).not.toHaveBeenCalled();
    getSnapshot.mockRestore();

}

export async function scenarioStreamsEveryDetectionClassificationToTheSubscriberExactlyOnce(): Promise<void> {

    const dir = await setup();
    const totalPages = 40;
    const deps = dependencies(dir);
    deps.getPageCount = vi.fn(async () => totalPages);
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    const batches = [
        {
            lastPage: 20,
            entered: Promise.withResolvers<undefined>(),
            released: Promise.withResolvers<undefined>(),
        },
        {
            lastPage: 30,
            entered: Promise.withResolvers<undefined>(),
            released: Promise.withResolvers<undefined>(),
        },
        {
            lastPage: totalPages,
            entered: Promise.withResolvers<undefined>(),
            released: Promise.withResolvers<undefined>(),
        },
    ];
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        const analyzePage = (pageNumber: number) => {
            onProgress({
                stage: 'page-analyzed',
                completedPages: pageNumber,
                totalPages,
                pageNumber,
            });
            onProgress({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        };
        let nextPage = 1;
        for (const batch of batches) {
            for (; nextPage <= batch.lastPage; nextPage += 1) analyzePage(nextPage);
            batch.entered.resolve(undefined);
            await batch.released.promise;
        }
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const streamedStates = () => owner.send.mock.calls
        .filter(([channel]) => channel === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
        .map(([
            _channel,
            state,
        ]) => decodeScanCleanupDetectionJobState(state)!);
    const started = await service.detectAll(owner, detectionRequest);
    service.subscribeDetectionJob(owner, started.jobId, detectionRequest);

    for (const batch of batches) {
        await batch.entered.promise;
        await vi.waitFor(() => expect(
            streamedStates().flatMap(state => state.results),
        ).toHaveLength(batch.lastPage));
        batch.released.resolve(undefined);
    }
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));

    const streamed = streamedStates();
    const streamedPages = streamed
        .filter(state => state.status !== 'completed')
        .flatMap(state => state.results.map(result => result.pageNumber));
    const rankedPhases = streamed.map(state => [
        'queued',
        'rasterizing',
        'detecting',
    ].indexOf(state.progress.stage));

    // Every classification reaches the renderer once: nothing is replayed
    // while the job runs, nothing is dropped by coalescing.
    expect(streamedPages).toEqual(Array.from({length: totalPages}, (_, index) => index + 1));
    expect(streamed.length).toBeLessThan(totalPages);
    expect(rankedPhases).toEqual([...rankedPhases].sort((left, right) => left - right));
    expect(streamed.at(-1)).toMatchObject({
        status: 'completed',
        progress: {
            completedUnits: totalPages,
            totalUnits: totalPages,
        },
    });
    expect(streamed.at(-1)?.results).toHaveLength(totalPages);

}

export async function scenarioKeepsXlargeDetectionEventPayloadsWithinTheRendererPageWindow(): Promise<void> {

    const dir = await setup();
    const totalPages = 1_025;
    const deps = dependencies(dir);
    const pageSize = (pageNumber: number) => ({
        ...DOCUMENT_PAGE_SIZES[0]!,
        pageNumber,
    });
    const store: IPdfPageSizeStore = {
        pageCount: totalPages,
        getPage: vi.fn(async pageNumber => pageSize(pageNumber)),
        readRange: vi.fn(async (firstPageNumber, lastPageNumberExclusive) => Array.from(
            {length: lastPageNumberExclusive - firstPageNumber},
            (_unused, index) => pageSize(firstPageNumber + index),
        )),
        forEachChunk: vi.fn(async onChunk => {
            for (let firstPageNumber = 1; firstPageNumber <= totalPages; firstPageNumber += 1_024) {
                const pages = await store.readRange(
                    firstPageNumber,
                    Math.min(totalPages + 1, firstPageNumber + 1_024),
                );
                await onChunk({
                    pageCount: totalPages,
                    chunkIndex: Math.floor((firstPageNumber - 1) / 1_024),
                    firstPageNumber,
                    offset: 0,
                    byteLength: 0,
                    pages,
                });
            }
        }),
        close: vi.fn(async () => undefined),
    };
    deps.getPageCount = vi.fn(async () => totalPages);
    deps.getPageSizeStore = vi.fn(() => store);
    deps.getPageSizes = vi.fn(async () => {
        throw new Error('xlarge detection must use the bounded page-size store');
    });
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    const firstBatchPublished = Promise.withResolvers<undefined>();
    const releaseFirstBatch = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{sourcePageIndex: number}>};
        for (const [
            index,
            page,
        ] of manifest.pages.entries()) {
            onProgress({
                stage: 'page-complete',
                completedPages: index + 1,
                totalPages: manifest.pages.length,
                pageNumber: page.sourcePageIndex + 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
        if (manifest.pages.length === 1_024) {
            firstBatchPublished.resolve(undefined);
            await releaseFirstBatch.promise;
        }
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    service.subscribeDetectionJob(owner, started.jobId, detectionRequest);

    await firstBatchPublished.promise;
    try {
        for (const state of [
            service.getDetectionJobState(owner, started.jobId, detectionRequest),
            service.subscribeDetectionJob(owner, started.jobId, detectionRequest),
        ]) {
            expect(state?.results.length).toBeLessThanOrEqual(256);
            expect(state?.progress.completedPageNumbers).toEqual([]);
            expect(state?.progress.completedPageNumbersTruncated).toBe(true);
            expect(state?.results).toEqual(expect.not.arrayContaining([
                expect.objectContaining({pagePlanEvidence: expect.anything()}),
                expect.objectContaining({sourcePageMetadata: expect.anything()}),
                expect.objectContaining({splitDiagnostics: expect.anything()}),
            ]));
        }
    } finally {
        releaseFirstBatch.resolve(undefined);
    }
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'), {timeout: 30_000});
    const xlargeStates = owner.send.mock.calls
        .filter(([channel]) => channel === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onDetectionJobState)
        .map(([
            _channel,
            state,
        ]) => state as TScanCleanupDetectionJobState)
        .filter(state => state.progress.totalUnits === totalPages);

    expect(xlargeStates.length).toBeGreaterThan(0);
    expect(xlargeStates.at(-1)?.status).toBe('completed');
    expect(Math.max(...xlargeStates.map(state => state.results.length))).toBeLessThanOrEqual(256);
    expect(xlargeStates.every(state => state.progress.completedPageNumbers?.length === 0)).toBe(true);
    expect(xlargeStates.every(state => state.progress.completedPageNumbersTruncated === true)).toBe(true);
    expect(xlargeStates.flatMap(state => state.results)).toEqual(
        expect.not.arrayContaining([
            expect.objectContaining({pagePlanEvidence: expect.anything()}),
            expect.objectContaining({sourcePageMetadata: expect.anything()}),
            expect.objectContaining({splitDiagnostics: expect.anything()}),
        ]),
    );

}

export async function scenarioReDetectsAChangedPageOverTheRastersItAlreadyHoldsPageForPage(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
        await writeFile(outputPath, pngWithDimensions(pageNumber, 1));
    });
    const manifests: Array<Array<{
        pageNumber: number;
        inputPath: string;
        rasterWidthPx: number;
    }>> = [];
        // The classification each page gets is read out of the pixels the
        // manifest points at, so a run that rasterized a page differently — or
        // left it out of the batch the sidecar reconciles over — cannot produce
        // the same results as the run before it.
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            inputPath: string;
            sourcePageIndex: number;
        }>};
        const pages = await Promise.all(manifest.pages.map(async page => {
            const raster = await readFile(page.inputPath);
            return {
                pageNumber: page.sourcePageIndex + 1,
                inputPath: page.inputPath,
                rasterWidthPx: raster.readUInt32BE(16),
            };
        }));
        manifests.push(pages);
        for (const [
            index,
            page,
        ] of pages.entries()) {
            onProgress({
                stage: 'page-complete',
                completedPages: index + 1,
                totalPages: pages.length,
                pageNumber: page.pageNumber,
                classification: page.rasterWidthPx > 1 ? 'two-page-spread' : 'single-uncut-page',
                confidence: 0.5 + page.rasterWidthPx / 10,
            });
        }
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const detect = async (request_: IScanCleanupDetectionRequest) => {
        const started = await service.detectAll(owner, request_);
        await vi.waitFor(() => expect(service.getDetectionJobState(
            owner,
            started.jobId,
            request_,
        )?.status).toBe('completed'));
        return service.getDetectionJobState(owner, started.jobId, request_)!;
    };

    const cold = await detect(detectionRequest);
    expect(deps.renderPage).toHaveBeenCalledTimes(3);

    const rotated: IScanCleanupDetectionRequest = {
        ...detectionRequest,
        options: {
            ...detectionRequest.options,
            pageOverrides: {'2': {
                rotationDegrees: 90,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
            }},
        },
    };
    const scoped = await detect(rotated);

    // The page override never reaches pdftoppm, so re-detecting after it
    // spawns nothing: every page comes out of retention.
    expect(deps.renderPage).toHaveBeenCalledTimes(3);
    expect(manifests).toHaveLength(2);
    expect(manifests[1]).toEqual(manifests[0]);
    expect(manifests[1]?.map(page => page.pageNumber)).toEqual([
        1,
        2,
        3,
    ]);
    expect(scoped.results).toEqual(cold.results);

}

export async function scenarioRasterizesOnlyThePagesRetentionNoLongerHoldsAndStillReconcilesOverTheWholeDocument(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    deps.acquireDetectionLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    const manifestPageCounts: number[] = [];
    deps.runSidecar = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
        await writeDetectionMetadata(manifestPath);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{sourcePageIndex: number}>};
        manifestPageCounts.push(manifest.pages.length);
        for (const [
            index,
            page,
        ] of manifest.pages.entries()) {
            onProgress({
                stage: 'page-complete',
                completedPages: index + 1,
                totalPages: manifest.pages.length,
                pageNumber: page.sourcePageIndex + 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('completed'));
    expect(deps.renderPage).toHaveBeenCalledTimes(3);

    const rasters = (await readdir(dir, {recursive: true}))
        .filter(entry => entry.endsWith('.png'))
        .map(entry => join(dir, entry));
    expect(rasters).toHaveLength(3);
    await rm(rasters[0]!);

    const resumed = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        resumed.jobId,
        detectionRequest,
    )?.status).toBe('completed'));

    expect(deps.renderPage).toHaveBeenCalledTimes(4);
    expect(manifestPageCounts).toEqual([
        3,
        3,
    ]);

}

export async function scenarioCancelsDetectAllThroughItsSignalAndRemovesItsScratchArtifacts(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<string>();
    const releaseLease = vi.fn(() => true);
    deps.acquireDetectionLease = vi.fn(async () => ({release: releaseLease}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath, signal) => {
        entered.resolve(manifestPath);
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
    });
    const service = createDetectionScenarioOwner(deps);
    const started = await service.detectAll(sender(), detectionRequest);
    const manifestPath = await entered.promise;

    expect(service.cancelDetection(sender(2), started.jobId, request)).toBe(false);
    expect(service.cancelDetection(sender(), started.jobId, {
        ...request,
        documentRevision: 'stale-revision',
    })).toBe(false);
    expect(service.cancelDetection(sender(), started.jobId, request)).toBe(true);
    await vi.waitFor(() => expect(service.getDetectionJobState(sender(), started.jobId, request)?.status).toBe('canceled'));
    expect(releaseLease).toHaveBeenCalledOnce();
    await expect(stat(join(manifestPath, '..'))).rejects.toMatchObject({code: 'ENOENT'});
    expect(service.cancelDetection(sender(), started.jobId, request)).toBe(false);

}

export async function scenarioJoinsIdenticalDetectionWorkAndReplacesAChangedRequestForTheSameOwner(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<AbortSignal>();
    deps.acquireDetectionLease = vi.fn()
        .mockImplementationOnce(async (_ownerId, signal) => {
            entered.resolve(signal);
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        })
        .mockResolvedValue({release: vi.fn(() => true)});
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const first = await service.detectAll(owner, detectionRequest);
    const signal = await entered.promise;

    await expect(service.detectAll(owner, detectionRequest)).resolves.toEqual(first);
    expect(deps.acquireDetectionLease).toHaveBeenCalledOnce();

    const replacement = await service.detectAll(owner, {
        ...detectionRequest,
        options: {
            ...detectionRequest.options,
            thickness: 1,
        },
    });
    expect(replacement.jobId).not.toBe(first.jobId);
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(deps.acquireDetectionLease).toHaveBeenCalledTimes(2));
    await service.dispose();

}

export async function scenarioStartsFreshIdenticalDetectionAfterCancellationIsAcknowledgedButNotTerminal(): Promise<void> {

    const {deps} = await previewDependencies();
    const firstEntered = Promise.withResolvers<undefined>();
    const settleFirstCancellation = Promise.withResolvers<undefined>();
    deps.acquireDetectionLease = vi.fn()
        .mockImplementationOnce(async (_ownerId, signal) => {
            firstEntered.resolve(undefined);
            await new Promise<void>(resolve => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                signal.addEventListener('abort', () => resolve(), {once: true});
            });
            await settleFirstCancellation.promise;
            throw signal.reason;
        })
        .mockImplementationOnce(async (_ownerId, signal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        }));
    const service = createDetectionScenarioOwner(deps);
    const owner = sender();
    const first = await service.detectAll(owner, detectionRequest);
    await firstEntered.promise;

    expect(service.cancelDetection(owner, first.jobId, detectionRequest)).toBe(true);
    // Detection's public progress remains queued until terminal even
    // though the registry envelope has accepted cancellation. Join
    // eligibility must not be inferred from this stale surface status.
    expect(service.getDetectionJobState(owner, first.jobId, detectionRequest)?.status).toBe('queued');

    const replacement = await service.detectAll(owner, detectionRequest);

    expect(replacement.jobId).not.toBe(first.jobId);
    expect(service.getDetectionJobState(owner, replacement.jobId, detectionRequest)?.status).toBe('queued');
    settleFirstCancellation.resolve(undefined);
    await vi.waitFor(() => expect(
        service.getDetectionJobState(owner, first.jobId, detectionRequest)?.status,
    ).toBe('canceled'));
    expect(service.getDetectionJobState(owner, replacement.jobId, detectionRequest)?.status).not.toBe('canceled');
    await service.dispose();

}

export async function scenarioCancelsDetectAllWhenTheOwningRendererIsDestroyed(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, manifestPath, signal) => {
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) {
                abort();
                return;
            }
            signal.addEventListener('abort', abort, {once: true});
        });
        void manifestPath;
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = lifecycleSender();
    const started = await service.detectAll(owner, detectionRequest);
    await entered.promise;

    owner.emit('destroyed');

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('canceled'));

}

export async function scenarioDoesNotDeliverTerminalDetectionStateAfterARendererIsDestroyed(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal, _log, onProgress) => {
        onProgress({
            stage: 'page-complete',
            completedPages: 1,
            totalPages: 3,
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.9,
        });
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
    });
    const service = createDetectionScenarioOwner(deps);
    const owner = lifecycleSender();
    const started = await service.detectAll(owner, detectionRequest);
    await entered.promise;

    const sendsBeforeDestroy = owner.send.mock.calls.length;
    owner.destroyed = true;
    owner.emit('destroyed');

    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectionRequest,
    )?.status).toBe('canceled'));
    expect(owner.send.mock.calls.length).toBe(sendsBeforeDestroy);
    await service.dispose();

}
