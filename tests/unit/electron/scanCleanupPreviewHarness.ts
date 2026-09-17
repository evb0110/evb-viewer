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
import {vi} from 'vitest';
import type {
    IScanCleanupDetectionRequest, IScanCleanupPreviewRequest,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import type {IScanCleanupPreviewService} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {materializeScanCleanupPreviewRequest} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {resolveScanCleanupPreviewRasterAdmissionPolicy as resolveScanCleanupRasterAdmissionPolicy} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import type {
    IScanCleanupDetectionSubscriber, IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    configureMainJobBroker, mainJobBroker,
} from '@electron/resources/jobBroker';
import {readScanCleanupFixtureFile} from '@tests/unit/electron/readScanCleanupFixtureFile';

configureMainJobBroker({
    logicalCpus: 11,
    totalRamBytes: 32 * 1024 ** 3,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

export const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

export function pngWithDimensions(width: number, height: number) {
    const png = PNG.slice();
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return png;
}

// pdftoppm rasterizes the same pixels whichever container it is asked for, so
// the fake renderers write one deterministic pattern in either format.
export function rasterPixels(width: number, height: number) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
        pixels[index * 3] = index % 251;
        pixels[index * 3 + 1] = (index * 7) % 253;
        pixels[index * 3 + 2] = (index * 13) % 257 % 256;
    }
    return pixels;
}

export function ppmWithDimensions(width: number, height: number) {
    return Buffer.concat([
        Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'),
        rasterPixels(width, height),
    ]);
}

export const request: IScanCleanupPreviewRequest = {
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

export const detectionRequest: IScanCleanupDetectionRequest = {
    ownerId: request.ownerId,
    documentRevision: request.documentRevision,
    sourcePdfPath: request.sourcePdfPath,
    options: request.options,
};

export function sender(id = 1) {
    return {
        id,
        isDestroyed: () => false,
        send: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
        removeListener: vi.fn(),
    } satisfies IScanCleanupDetectionSubscriber;
}

export class LifecycleSender extends EventEmitter {
    readonly id: number;
    destroyed = false;
    readonly isDestroyed = () => this.destroyed;
    readonly send = vi.fn();

    constructor(id: number) {
        super();
        this.id = id;
    }
}

export function isScanCleanupDetectionSubscriber(sender: LifecycleSender): sender is LifecycleSender & IScanCleanupDetectionSubscriber {
    return typeof sender.id === 'number'
        && typeof sender.isDestroyed === 'function'
        && typeof sender.send === 'function'
        && typeof sender.on === 'function'
        && typeof sender.once === 'function'
        && typeof sender.removeListener === 'function';
}

export function lifecycleSender(id = 100): LifecycleSender & IScanCleanupDetectionSubscriber {
    const sender = new LifecycleSender(id);
    if (!isScanCleanupDetectionSubscriber(sender)) {
        throw new Error('test lifecycle sender is incomplete');
    }
    return sender;
}

export function previewOf(
    service: Pick<IScanCleanupPreviewService, 'preview'>,
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

export async function createScanCleanupPreviewTestDirectory() {
    return mkdtemp(join(tmpdir(), 'scan-cleanup-preview-test-'));
}

export async function waitForRelease(release: Promise<unknown>, signal: AbortSignal) {
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

export const DOCUMENT_PAGE_SIZES = [
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

const PREVIEW_DPI = 150;
export const DOCUMENT_CANVAS = {
    widthPoints: 612,
    heightPoints: 792,
    widthPx: Math.floor(612 / 72 * PREVIEW_DPI),
    heightPx: Math.floor(792 / 72 * PREVIEW_DPI),
};

export const SETTLED_SINGLE_LAYOUT_BY_PAGE = {
    '1': 'single-uncut-page',
    '2': 'single-uncut-page',
    '3': 'single-uncut-page',
} as const;

export function createScanCleanupPageRasterSource(input: {
    detected?: boolean;
    pages?: Iterable<number>;
    sourceDpiByPage?: ReadonlyMap<number, number>;
    bilevelLayerPages?: Iterable<number>;
    dominantBilevelLayerPages?: Iterable<number>;
    backgroundDpiByPage?: ReadonlyMap<number, number>;
    documentDpi?: number | null;
}) {
    const pageNumbers = new Set([
        ...(input.pages ?? []),
        ...(input.sourceDpiByPage?.keys() ?? []),
        ...(input.backgroundDpiByPage?.keys() ?? []),
    ]);
    const bilevelLayerPages = new Set(input.bilevelLayerPages ?? []);
    const dominantBilevelLayerPages = new Set(input.dominantBilevelLayerPages ?? []);
    const rasters = new Map<number, {
        dpi: number;
        width: number;
        height: number;
        hasBilevelLayer?: boolean;
        hasDominantBilevelLayer?: boolean;
        backgroundDpi?: number;
    }>();
    for (const pageNumber of pageNumbers) {
        const backgroundDpi = input.backgroundDpiByPage?.get(pageNumber);
        rasters.set(pageNumber, {
            dpi: input.sourceDpiByPage?.get(pageNumber) ?? input.documentDpi ?? 150,
            width: 1_000,
            height: 1_400,
            ...(bilevelLayerPages.has(pageNumber)
                ? {hasBilevelLayer: true}
                : {}),
            ...(dominantBilevelLayerPages.has(pageNumber)
                ? {hasDominantBilevelLayer: true}
                : {}),
            ...(backgroundDpi === undefined ? {} : {backgroundDpi}),
        });
    }
    return {
        detected: input.detected ?? pageNumbers.size > 0,
        documentDpi: input.documentDpi ?? null,
        getPageRaster: (pageNumber: number) => rasters.get(pageNumber),
    };
}

export const documentPrior = {
    dominantLayout: 'two-page-spread' as const,
    cutterRatioMedian: 0.5,
    clusterDims: {
        widthPx: 1,
        heightPx: 1,
    },
    agreementStrength: 0.8,
};

export function decodePpm(bytes: Buffer) {
    const match = /^P6\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(bytes.subarray(0, 64).toString('ascii'));
    if (!match) throw new Error('not a P6 raster');
    const width = Number(match[1]);
    const height = Number(match[2]);
    return {
        width,
        height,
        pixels: bytes.subarray(match[0].length, match[0].length + width * height * 3),
    };
}

export type TScanCleanupPreviewDependenciesOverride = Partial<IScanCleanupPreviewDependencies> & {fileSystem?: Partial<NonNullable<IScanCleanupPreviewDependencies['fileSystem']>>;};

export async function createScanCleanupPreviewTestContext(
    directories: string[],
    overrides: TScanCleanupPreviewDependenciesOverride = {},
) {
    const dir = await createScanCleanupPreviewTestDirectory();
    directories.push(dir);
    return {
        dir,
        deps: createScanCleanupPreviewDependencies(dir, overrides),
    };
}

export function createScanCleanupPreviewDependencies(
    dir: string,
    overrides: TScanCleanupPreviewDependenciesOverride = {},
): IScanCleanupPreviewDependencies {
    const fileSystem = {
        copyFile,
        mkdir,
        mkdtemp,
        open,
        readFile: readScanCleanupFixtureFile,
        readdir,
        rm,
        stat,
        writeFile,
    } satisfies NonNullable<IScanCleanupPreviewDependencies['fileSystem']>;
    const base: IScanCleanupPreviewDependencies = {
        fileSystem,
        getAvailableScratchBytes: async () => Number.MAX_SAFE_INTEGER,
        resolveRasterAdmissionPolicy: (supportsRasterStreaming, options) => resolveScanCleanupRasterAdmissionPolicy(
            mainJobBroker.getSnapshot().capacity,
            supportsRasterStreaming,
            options,
        ),
        acquirePreviewLease: async () => ({release: () => true}),
        acquireDetectionLease: async () => ({release: () => true}),
        getSourceStatIdentity: async () => 'fixture-source',
        resolveQpdfBinary: () => '/usr/bin/qpdf',
        getPageCount: vi.fn(async () => 3),
        getPageSizes: vi.fn(async () => DOCUMENT_PAGE_SIZES),
        getPageSizeStore: vi.fn(async () => createArrayBackedPdfPageSizeStore(DOCUMENT_PAGE_SIZES)),
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
                warningEvents: [],
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
    const {
        fileSystem: fileSystemOverride,
        ...dependencyOverrides
    } = overrides;
    const dependencies: IScanCleanupPreviewDependencies = {
        ...base,
        ...dependencyOverrides,
        ...(fileSystemOverride === undefined ? {} : {fileSystem: {
            ...fileSystem,
            ...fileSystemOverride,
        }}),
    };
    const defaultGetPageSizes = base.getPageSizes;
    const defaultGetPageCount = base.getPageCount;
    if (overrides.getPageSizeStore === undefined) {
        dependencies.getPageSizeStore = vi.fn(async (pdfPath, options) => {
            const pageSizes = dependencies.getPageSizes !== defaultGetPageSizes
                ? await dependencies.getPageSizes!(pdfPath, options)
                : Array.from({length: dependencies.getPageCount === defaultGetPageCount
                    ? DOCUMENT_PAGE_SIZES.length
                    : await dependencies.getPageCount(pdfPath, {signal: options.signal})}, (_, index) => ({
                    ...DOCUMENT_PAGE_SIZES[Math.min(index, DOCUMENT_PAGE_SIZES.length - 1)]!,
                    pageNumber: index + 1,
                }));
            return createArrayBackedPdfPageSizeStore(pageSizes);
        });
    }
    return dependencies;
}
