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
import {reactive} from 'vue';
import type {IScanCleanupPreviewRequest} from '@contracts/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import {isScanCleanupErrorEnvelope} from '@contracts/electronApiScanCleanup';

import {findSerializableErrorEnvelope} from '@contracts/serializableError';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {readScanCleanupFixtureFile} from '@tests/unit/electron/readScanCleanupFixtureFile';
import {
    defaultDependencies,
    materializeScanCleanupPreviewRequest,
} from '@electron/features/scan-cleanup/scanCleanupPreviewCompositionDefaults';
import {
    forgetRetiredWorkingCopyOriginal,
    rememberRetiredWorkingCopyOriginal,
} from '@electron/file-access/workingCopyStore';
import {scanCleanupPreviewLifecycle} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {
    IScanCleanupDetectionSubscriber,
    IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';

import {NativeScanCleanupError} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {
    decodeScanCleanupDetectionJobState,
    decodeScanCleanupPreviewResult,
} from '@contracts/scan-cleanup/ipcResultCodecs';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scanCleanupPlatformFeature';
import {configureMainJobBroker} from '@electron/resources/jobBroker';

configureMainJobBroker({
    logicalCpus: 11,
    totalRamBytes: 32 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

const SCAN_CLEANUP_CHANNELS = SCAN_CLEANUP_PLATFORM_FEATURE.invokeChannels;
const SCAN_CLEANUP_IPC_CODECS = SCAN_CLEANUP_PLATFORM_FEATURE.ipcCodecs;
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

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

export async function scenarioPreservesFoldClippingThroughNativeArtifactAndIPCCodecBoundaries(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{outputs: Array<{
            metadataPath: string;
            outputPath: string;
        }>;}>};
        const output = manifest.pages[0]!.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
        await writeFile(output.outputPath, pngWithDimensions(4, 1));
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx: 4,
            canvasWidthPx: 4,
            matchedCanvasContentWidthPx: 4,
            foldClipLeftPx: 1,
            foldClipRightPx: 1,
        }));
    });

    const result = await previewOf(scanCleanupPreviewLifecycle(deps), sender(), request);
    expect(result.outputs[0]?.metadata).toMatchObject({
        foldClipLeftPx: 1,
        foldClipRightPx: 1,
    });
    expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [{metadata: {
        foldClipLeftPx: 1,
        foldClipRightPx: 1,
    }}]});

}

export async function scenarioAcceptsFourInRangeMarginsAndRejectsInvalidOrIncompleteMarginShapes(): Promise<void> {

    const validRequest = {
        ...request,
        options: {
            ...request.options,
            marginsMm: {
                leftMm: 0,
                topMm: 6.5,
                rightMm: 12,
                bottomMm: 25,
            },
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                marginsMm: {
                    leftMm: 1,
                    topMm: 2,
                    rightMm: 3,
                    bottomMm: 4,
                },
            }},
        },
    };
    const codec = SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview];
    expect(codec.decodeArgs([validRequest])).toEqual([validRequest]);

    const invalidMargins = [
        {
            leftMm: -1,
            topMm: 2,
            rightMm: 3,
            bottomMm: 4,
        },
        {
            leftMm: 1,
            topMm: Number.NaN,
            rightMm: 3,
            bottomMm: 4,
        },
        {
            leftMm: 1,
            topMm: 2,
            rightMm: 26,
            bottomMm: 4,
        },
        {
            leftMm: 1,
            topMm: 2,
            rightMm: 3,
        },
    ];
    for (const marginsMm of invalidMargins) {
        expect(() => codec.decodeArgs([{
            ...request,
            options: {
                ...request.options,
                marginsMm,
            },
        }])).toThrow('invalid scan-cleanup margins');
    }

    const legacyMarginKey = `margin${'Mm'}`;
    const {
        marginsMm: _marginsMm,
        ...optionsWithoutMargins
    } = request.options;
    expect(() => codec.decodeArgs([{
        ...request,
        options: {
            ...optionsWithoutMargins,
            [legacyMarginKey]: 5,
        },
    }])).toThrow('invalid scan-cleanup margins');

}

export async function scenarioRoundTripsNormalizedOverrideGeometryThroughTheIPCCodec(): Promise<void> {

    const normalizedRequest: IScanCleanupPreviewRequest = {
        ...request,
        outputModeRecommendation: 'bw',
        options: {
            ...request.options,
            pageOverrides: {'2': {
                rotationDegrees: 270,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: {
                    xNormalized: 0.375,
                    rotationDegrees: 270,
                },
                manualContentBoxes: {right: {
                    xNormalized: 0.04,
                    yNormalized: 0.12,
                    widthNormalized: 0.42,
                    heightNormalized: 0.7,
                    rotationDegrees: 270,
                }},
                manualZones: {
                    picture: [{
                        polygon: {
                            points: [
                                {
                                    xNormalized: 0.1,
                                    yNormalized: 0.2,
                                },
                                {
                                    xNormalized: 0.8,
                                    yNormalized: 0.2,
                                },
                                {
                                    xNormalized: 0.8,
                                    yNormalized: 0.9,
                                },
                            ],
                            rotationDegrees: 270,
                        },
                        layer: 'painter2',
                    }],
                    fill: [],
                },
            }},
        },
    };

    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([normalizedRequest]))
        .toEqual([normalizedRequest]);

}

export async function scenarioValidatesHighDetailViewportRequests(): Promise<void> {

    const detailRequest: IScanCleanupPreviewRequest = {
        ...request,
        detail: {
            viewports: {left: {
                xNormalized: 0.125,
                yNormalized: 0.25,
                widthNormalized: 0.5,
                heightNormalized: 0.4,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    };

    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([detailRequest]))
        .toEqual([detailRequest]);
    expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([{
        ...detailRequest,
        detail: {
            ...detailRequest.detail!,
            viewports: {},
        },
    }])).toThrow('invalid scan-cleanup detail preview request');
    expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([{
        ...detailRequest,
        detail: {
            ...detailRequest.detail!,
            viewports: {left: undefined},
        },
    }])).toThrow('invalid scan-cleanup detail preview request');

}

export async function scenarioValidatesTheRetainedNavigationWindowOnAPreviewCancellation(): Promise<void> {

    const codec = SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.cancelPreview];
    const cancelRequest = {
        sourcePdfPath: request.sourcePdfPath,
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        invalidateRawCache: false,
        retainPages: [
            199,
            200,
            201,
        ],
    };

    expect(codec.decodeArgs([cancelRequest])).toEqual([cancelRequest]);
    for (const retainPages of [
        [0],
        [1.5],
        ['200'],
        Array.from({length: 17}, (_unused, index) => index + 1),
        'all',
    ]) {
        expect(() => codec.decodeArgs([{
            ...cancelRequest,
            retainPages,
        }])).toThrow('invalid scan-cleanup retained preview pages');
    }

}

export async function scenarioSerializesNestedReactivePageOverridesForEveryIPCRequest(): Promise<void> {

    const reactiveOptions = reactive({
        ...request.options,
        outputMode: 'auto' as const,
        pageOverrides: {
            '2': {
                rotationDegrees: 90 as const,
                layoutOverride: 'spread' as const,
                excluded: false,
                outputModeOverride: 'mixed' as const,
                manualSplit: {
                    xNormalized: 0.4,
                    rotationDegrees: 90 as const,
                },
                manualContentBoxes: {left: {
                    xNormalized: 0.01,
                    yNormalized: 0.02,
                    widthNormalized: 0.32,
                    heightNormalized: 0.54,
                    rotationDegrees: 90 as const,
                }},
                placementOverrides: {left: 'bottom-right' as const},
            },
            '3': {
                rotationDegrees: 0 as const,
                layoutOverride: 'auto' as const,
                excluded: false,
                outputModeOverride: 'color' as const,
                manualSplit: null,
            },
        },
    });
    const options = toPlainScanCleanupOptions(reactiveOptions);
    const previewRequest = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        requestId: request.requestId,
        sourcePdfPath: request.sourcePdfPath,
        pageNumber: request.pageNumber,
        options,
    };
    const startRequest = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        options,
        sourcePageNumbers: [
            1,
            3,
        ],
    };

    expect(() => structuredClone(previewRequest)).not.toThrow();
    expect(() => structuredClone(startRequest)).not.toThrow();
    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.preview].decodeArgs([previewRequest]))
        .toEqual([previewRequest]);
    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.cancelPreview].decodeArgs([{
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        invalidateRawCache: false,
    }])).toEqual([{
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        invalidateRawCache: false,
    }]);
    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.start].decodeArgs([startRequest]))
        .toEqual([startRequest]);
    expect(SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.detectAll].decodeArgs([{
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        options,
    }])).toEqual([{
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        options,
    }]);

}

export async function scenarioRejectsAsymmetricStartErrorsAndImpossibleJobProgress(): Promise<void> {

    expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.start].decodeResult({
        started: false,
        jobId: 'job-1',
        error: 'failed',
        errorCode: 'untyped-code',
    })).toThrow('typed error');
    expect(() => SCAN_CLEANUP_IPC_CODECS[SCAN_CLEANUP_CHANNELS.getJobState].decodeResult({
        jobId: 'job-1',
        status: 'running',
        progress: {
            stage: 'rendering',
            completedUnits: 2,
            totalUnits: 1,
            percent: 50,
        },
        updatedAtMs: Date.now(),
    })).toThrow('invalid scan-cleanup progress');

}

export async function scenarioDemandMaterializesLazyOriginalInputBeforeScanCleanupPreview(): Promise<void> {

    const {deps} = await previewDependencies();
    vi.mocked(deps.materializeWorkingCopy).mockResolvedValue({
        logicalRef: request.sourcePdfPath,
        physicalWorkingCopyPath: '/managed/document.pdf',
        sourceFingerprint: 'source-fingerprint',
    });

    await previewOf(scanCleanupPreviewLifecycle(deps), sender(), request);

    expect(deps.materializeWorkingCopy).toHaveBeenCalledWith(request.sourcePdfPath, {
        ownerWebContentsId: 1,
        reason: 'scan-cleanup',
        signal: expect.any(AbortSignal),
    });
    expect(deps.renderPage).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        1,
        '/managed/document.pdf',
        expect.any(String),
        expect.any(Number),
        undefined,
        expect.any(AbortSignal),
        undefined,
        expect.objectContaining({
            maxDimensionPx: 40_000,
            maxPixels: 45_000_000,
        }),
    );

}

export async function scenarioCancelsPreviewWorkWhoseWorkingCopyRegistrationWasRetired(): Promise<void> {

    const previewSender = sender();
    rememberRetiredWorkingCopyOriginal(request.sourcePdfPath, '/original.pdf', previewSender.id);
    try {
        const service = scanCleanupPreviewLifecycle(defaultDependencies);

        await expect(service.preview(previewSender, request)).resolves.toEqual({canceled: true});
    } finally {
        forgetRetiredWorkingCopyOriginal(request.sourcePdfPath);
    }

}

export async function scenarioReportsPreviewWorkForASourceThisOwnerNeverHeldAsAFailure(): Promise<void> {

    const service = scanCleanupPreviewLifecycle(defaultDependencies);

    // A path nothing registered is not a page the user navigated away from:
    // reporting it as a cancellation would leave the renderer spinning on a
    // request that will never be answered.
    const error = await service.preview(sender(), request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(findSerializableErrorEnvelope(error, isScanCleanupErrorEnvelope)).toMatchObject({
        code: 'internal',
        message: expect.stringMatching(/not managed by this owner/u),
    });

}

export async function scenarioSerializesNativePreviewErrorCodesThroughTheMessageOnlyIPCBoundary(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.runSidecar = vi.fn(async () => {
        throw new NativeScanCleanupError('too-large', 'Preview exceeds native limits');
    });
    const service = scanCleanupPreviewLifecycle(deps);

    const error = await previewOf(service, sender(), request).catch((caught: unknown) => caught);

    expect(findSerializableErrorEnvelope(error, isScanCleanupErrorEnvelope)).toEqual({
        code: 'too-large',
        message: 'Preview exceeds native limits',
    });

}

export async function scenarioSkipsMaterializationForQueuedPreviewWorkCanceledBeforeItDequeues(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const firstEntered = Promise.withResolvers<undefined>();
    const releaseFirst = Promise.withResolvers<undefined>();
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        firstEntered.resolve(undefined);
        await waitForRelease(releaseFirst.promise, args[7]!);
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();

    const first = previewOf(service, previewSender, request);
    await firstEntered.promise;
    const queued = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    service.cancel(previewSender, {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    });
    releaseFirst.resolve(undefined);

    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await expect(queued).rejects.toMatchObject({name: 'AbortError'});
    expect(deps.materializeWorkingCopy).toHaveBeenCalledTimes(1);

}

export async function scenarioKeepsEagerScanCleanupPreviewPathsUnchanged(): Promise<void> {

    const {deps} = await previewDependencies();

    await previewOf(scanCleanupPreviewLifecycle(deps), sender(), request);

    expect(deps.renderPage).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        1,
        request.sourcePdfPath,
        expect.any(String),
        expect.any(Number),
        undefined,
        expect.any(AbortSignal),
        undefined,
        expect.objectContaining({
            maxDimensionPx: 40_000,
            maxPixels: 45_000_000,
        }),
    );

}

export async function scenarioAcceptsUnboundedNonnegativeSkewEvidenceAndRejectsInvalidValuesAtBothMetadataBoundaries(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);
    expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
        outputs: [{metadata: {skewConfidence: 2.4}}],
        pageMetadata: {skewConfidence: 2.4},
    });

    for (const invalid of [
        -0.01,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ]) {
        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    skewConfidence: invalid,
                },
            })),
        })).toThrow('invalid scan-cleanup preview skew confidence');
        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            pageMetadata: {
                ...result.pageMetadata,
                skewConfidence: invalid,
            },
        })).toThrow('invalid scan-cleanup preview page skew confidence');
    }

}

export async function scenarioValidatesAdditiveRenderRegionMetadataAgainstTheFullIntrinsicOutput(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);
    const withRegion = {
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                outputWidthPx: 10,
                outputHeightPx: 20,
                canvasWidthPx: 10,
                canvasHeightPx: 20,
                renderRegion: {
                    xPx: 2,
                    yPx: 3,
                    widthPx: 4,
                    heightPx: 5,
                },
            },
        })),
    };

    const decodedWithRegion = decodeScanCleanupPreviewResult(withRegion);
    if (decodedWithRegion.canceled === true) throw new Error('unexpected canceled preview');
    expect(decodedWithRegion.outputs[0]?.metadata.renderRegion)
        .toEqual({
            xPx: 2,
            yPx: 3,
            widthPx: 4,
            heightPx: 5,
        });
    expect(() => decodeScanCleanupPreviewResult({
        ...withRegion,
        outputs: withRegion.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                renderRegion: {
                    xPx: 8,
                    yPx: 3,
                    widthPx: 4,
                    heightPx: 5,
                },
            },
        })),
    })).toThrow('render region');

}

export async function scenarioRejectsOversizedEncodedImageResponsesAtTheIPCBoundary(): Promise<void> {

    expect(() => decodeScanCleanupPreviewResult({
        pageNumber: 1,
        totalPages: 1,
        rawWidthPx: 1,
        rawHeightPx: 1,
        rawImageData: PNG,
        outputs: [{
            imageData: new Uint8Array(32 * 1024 * 1024 + 1),
            metadata: {
                half: 'full',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                outputWidthPx: 1,
                outputHeightPx: 1,
                canvasWidthPx: 1,
                canvasHeightPx: 1,
                placementOffsetXPx: 0,
                placementOffsetYPx: 0,
            },
        }],
    })).toThrow('invalid scan-cleanup preview output image');

}

export async function scenarioRejectsLayoutConfidenceOutsideTheUnitIntervalAtTheIPCBoundary(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);

    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                layoutConfidence: 1.1,
            },
        })),
    })).toThrow('invalid scan-cleanup preview layout confidence');

}

export async function scenarioRejectsMalformedCleanupDiagnosticFlagsAtTheIPCBoundary(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);

    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                despeckleFallback: 'yes',
            },
        })),
    })).toThrow('invalid scan-cleanup preview metadata');

    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                contentDiagnostics: {
                    sideConfidence: {
                        left: 1.2,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    textMask: {
                        analysisWidthPx: 1,
                        analysisHeightPx: 1,
                        inkPixels: 0,
                        lineCount: 0,
                    },
                },
            },
        })),
    })).toThrow('invalid scan-cleanup preview content left confidence');

}

export async function scenarioRejectsNonNumericRotationsAndUnsafePixelGeometryAtTheIPCBoundary(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);

    for (const rotationDegrees of [
        '0',
        null,
    ]) {
        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            pageMetadata: {
                ...result.pageMetadata,
                rotationDegrees,
            },
        })).toThrow('invalid scan-cleanup preview page metadata');
        expect(() => decodeScanCleanupPreviewResult({
            ...result,
            outputs: result.outputs.map(output => ({
                ...output,
                metadata: {
                    ...output.metadata,
                    rotationDegrees,
                },
            })),
        })).toThrow('invalid scan-cleanup preview metadata');
    }

    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        pageMetadata: {
            ...result.pageMetadata,
            cutterXPx: Number.MAX_SAFE_INTEGER + 1,
        },
    })).toThrow('invalid scan-cleanup preview page metadata');
    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                sourceRegion: {
                    ...output.metadata.sourceRegion,
                    xPx: Number.MAX_SAFE_INTEGER + 1,
                },
            },
        })),
    })).toThrow('invalid scan-cleanup preview source region');
    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        pageMetadata: {
            ...result.pageMetadata,
            splitSeam: {points: [
                {
                    x: Number.MAX_SAFE_INTEGER + 1,
                    y: 0,
                },
                {
                    x: 1,
                    y: 1,
                },
            ]},
        },
    })).toThrow('invalid scan-cleanup preview split seam point 0 x');

}

export async function scenarioRequiresNamedFiniteAppliedMarginsAtTheIPCBoundary(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);
    const withMargins = (appliedMargins: unknown) => ({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                appliedMargins,
            },
        })),
    });

    expect(() => decodeScanCleanupPreviewResult(withMargins([
        1,
        2,
        3,
        4,
    ]))).toThrow('invalid scan-cleanup preview metadata');
    expect(() => decodeScanCleanupPreviewResult(withMargins({
        leftPx: Number.NaN,
        topPx: 2,
        rightPx: 3,
        bottomPx: 4,
    }))).toThrow('invalid scan-cleanup preview applied left margin');

}

export async function scenarioRejectsFullyOffCanvasAndInconsistentIntrinsicOverflowIntervalsAtTheIPCBoundary(): Promise<void> {

    const dir = await setup();
    const result = await previewOf(scanCleanupPreviewLifecycle(dependencies(dir)), sender(), request);
    const withGeometry = (geometry: Record<string, number>) => ({
        ...result,
        outputs: result.outputs.map(output => ({
            ...output,
            metadata: {
                ...output.metadata,
                ...geometry,
            },
        })),
    });

    expect(() => decodeScanCleanupPreviewResult(withGeometry({
        canvasWidthPx: 100,
        matchedCanvasContentWidthPx: 200,
        matchedCanvasIntrinsicOverflowLeftPx: 200,
        placementOffsetXPx: 0,
    }))).toThrow('invalid scan-cleanup preview intrinsic/canvas placement');
    expect(() => decodeScanCleanupPreviewResult(withGeometry({
        matchedCanvasIntrinsicOverflowLeftPx: 10,
        placementOffsetXPx: 5,
    }))).toThrow('invalid scan-cleanup preview intrinsic/canvas placement');
    expect(() => decodeScanCleanupPreviewResult(withGeometry({
        matchedCanvasIntrinsicOverflowTopPx: 2,
        placementOffsetYPx: 1,
    }))).toThrow('invalid scan-cleanup preview intrinsic/canvas placement');
    expect(() => decodeScanCleanupPreviewResult(withGeometry({foldClipLeftPx: 1}))).toThrow('invalid scan-cleanup preview intrinsic/canvas placement');

}

export async function scenarioAcceptsOptionalDetectionTextAxisAndRecommendationReasonsAndRejectsMalformedValues(): Promise<void> {

    const state = {
        jobId: 'detect-axis',
        status: 'completed',
        progress: {
            stage: 'detecting',
            completedUnits: 1,
            totalUnits: 1,
            percent: 100,
            completedPageNumbers: [1],
        },
        results: [{
            pageNumber: 1,
            classification: 'single-uncut-page',
            confidence: 0.9,
            cutterXPx: null,
            tier1Verdict: 'single-uncut-page',
            reconciled: false,
            clusterAgreement: 0,
            documentPrior: null,
            textAxis: {
                sideways: true,
                confidence: 0.98,
            },
            recommendedOutputModeReason: 'blank',
            sourcePageMetadata: {
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 612,
                heightPoints: 792,
                rotation: 0,
                sourceDpi: 300,
                dominantImageWidthPx: 2_550,
                dominantImageHeightPx: 3_300,
                dominantImageWidthPoints: 612,
                dominantImageHeightPoints: 792,
            },
        }],
        updatedAtMs: Date.now(),
    };
    expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.textAxis).toEqual({
        sideways: true,
        confidence: 0.98,
    });
    expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.recommendedOutputModeReason).toBe('blank');
    expect(decodeScanCleanupDetectionJobState(state)?.results[0]?.sourcePageMetadata).toEqual(
        state.results[0]!.sourcePageMetadata,
    );

    const axislessResult = structuredClone(state.results[0]!);
    Reflect.deleteProperty(axislessResult, 'textAxis');
    const withoutAxis = {
        ...structuredClone(state),
        results: [axislessResult],
    };
    expect(decodeScanCleanupDetectionJobState(withoutAxis)?.results[0]).not.toHaveProperty('textAxis');

    const malformed = structuredClone(state);
    malformed.results[0]!.textAxis.confidence = Number.NaN;
    expect(() => decodeScanCleanupDetectionJobState(malformed)).toThrow('detection result');

    const malformedReason = structuredClone(state);
    malformedReason.results[0]!.recommendedOutputModeReason = 'empty';
    expect(() => decodeScanCleanupDetectionJobState(malformedReason)).toThrow('detection result');

    const mismatchedMetadata = structuredClone(state);
    mismatchedMetadata.results[0]!.sourcePageMetadata.pageNumber = 2;
    expect(() => decodeScanCleanupDetectionJobState(mismatchedMetadata)).toThrow(
        'detection source page metadata',
    );

    const unsafeCutter = structuredClone(state);
    Reflect.set(unsafeCutter.results[0]!, 'cutterXPx', Number.MAX_SAFE_INTEGER + 1);
    expect(() => decodeScanCleanupDetectionJobState(unsafeCutter)).toThrow('detection result');

}

export async function scenarioKeepsTheOwnerListenersUntilItsLastPreviewJobEnds(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = new Map<number, PromiseWithResolvers<undefined>>([
        [
            1,
            Promise.withResolvers<undefined>(),
        ],
        [
            2,
            Promise.withResolvers<undefined>(),
        ],
    ]);
    const releases = new Map<number, PromiseWithResolvers<undefined>>([
        [
            1,
            Promise.withResolvers<undefined>(),
        ],
        [
            2,
            Promise.withResolvers<undefined>(),
        ],
    ]);
    const originalSidecar = deps.runSidecar;
    deps.acquirePreviewLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{sourcePageIndex: number}>};
        const pageNumber = (manifest.pages[0]?.sourcePageIndex ?? 0) + 1;
        entered.get(pageNumber)?.resolve(undefined);
        await waitForRelease(releases.get(pageNumber)!.promise, signal);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    const first = previewOf(service, owner, {
        ...request,
        requestId: requireRequestId('preview-page-1'),
        pageNumber: requirePageNumber(1),
    });
    const second = previewOf(service, owner, {
        ...request,
        requestId: requireRequestId('preview-page-2'),
        pageNumber: requirePageNumber(2),
    });
    await Promise.all([
        entered.get(1)!.promise,
        entered.get(2)!.promise,
    ]);

    expect(owner.listenerCount('destroyed')).toBe(1);
    expect(owner.listenerCount('render-process-gone')).toBe(1);

    releases.get(1)!.resolve(undefined);
    await first;
    expect(owner.listenerCount('destroyed')).toBe(1);
    expect(owner.listenerCount('render-process-gone')).toBe(1);
    releases.get(2)!.resolve(undefined);
    await second;
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(owner.listenerCount('render-process-gone')).toBe(0);

}

export async function scenarioCancelsAPreviewImmediatelyWhenItsWebContentsIsAlreadyDestroyed(): Promise<void> {

    const deps = dependencies('/unused');
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    owner.destroyed = true;

    await expect(service.preview(owner, request)).resolves.toEqual({canceled: true});
    expect(deps.materializeWorkingCopy).not.toHaveBeenCalled();
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(owner.listenerCount('render-process-gone')).toBe(0);

}
