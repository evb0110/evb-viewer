import {
    describe, it, expect, afterEach, vi,
} from 'vitest';
import {
    defaultDependencies, scanCleanupPreviewLifecycle,
} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import {
    scanCleanupPreviewRenderingOwner, type IScanCleanupPreviewRenderingOwner,
} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingOwner';
import {
    readFile, readdir, rm, stat, writeFile,
} from 'fs/promises';
import {dirname} from 'path';
import type {IScanCleanupPreviewRequest} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {createArrayBackedPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {writeScanCleanupDetectionMetadata as writeDetectionMetadata} from '@tests/unit/electron/writeScanCleanupDetectionMetadata';
import type {IScanCleanupPreviewDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {formatScanCleanupWarningEvent} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {fitScanCleanupMarginAxisPx} from '@evb/scan-cleanup/core/policy/documentCanvas';
import {decodeScanCleanupPreviewResult} from '@contracts/scan-cleanup/ipcResultCodecs';
import {
    createScanCleanupPreviewTestContext,
    createScanCleanupPageRasterSource,
    decodePpm,
    detectionRequest,
    DOCUMENT_CANVAS,
    DOCUMENT_PAGE_SIZES,
    documentPrior,
    PNG,
    pngWithDimensions,
    ppmWithDimensions,
    previewOf,
    rasterPixels,
    request,
    SETTLED_SINGLE_LAYOUT_BY_PAGE,
    sender,
    waitForRelease,
} from '@tests/unit/electron/scanCleanupPreviewHarness';
import {isPathWithinRoot} from '@tests/helpers/isPathWithinRoot';





type TDetailPreviewManifest = Record<'pages', Array<{
    options: Record<string, unknown>;
    detailRenderPlan?: {
        baseMetadataPath?: string;
        baseCleanedRasterPath?: string;
        sourceCrop: {
            xPx: number;
            yPx: number;
            widthPx: number;
            heightPx: number;
        };
        renderRegion: {
            xPx: number;
            yPx: number;
            widthPx: number;
            heightPx: number;
        };
    };
    outputs: Array<{
        outputPath: string;
        metadataPath: string;
    }>;
}>>;

function createRenderingScenarioOwner(deps: IScanCleanupPreviewDependencies): IScanCleanupPreviewRenderingOwner {
    const retention = scanCleanupRasterRetention(deps);
    const owner = scanCleanupPreviewRenderingOwner(deps, retention);
    return {
        cancel: owner.cancel,
        dispose: async () => {
            await owner.dispose();
            await retention.dispose();
        },
        preview: owner.preview,
    };
}

const dirs: string[] = [];
const dependenciesOverride = {resolveRasterAdmissionPolicy: () => ({
    rasterConcurrency: 2,
    rasterStreaming: false,
})};

async function previewFixture() {
    const {
        dir, deps,
    } = await createScanCleanupPreviewTestContext(dirs, dependenciesOverride);
    const service = createRenderingScenarioOwner(deps);
    return {
        dir,
        deps,
        service,
    };
}

async function previewDependencies() {
    return createScanCleanupPreviewTestContext(dirs, dependenciesOverride);
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

export async function scenarioReturnsRealSidecarBytesAndValidatedMetadata(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    const runSidecar = deps.runSidecar;
    let previewMatchPageSize: boolean | undefined;
    let previewMode = false;
    let previewDocumentPrior: unknown;
    let previewOptions: Record<string, unknown> | undefined;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            renderMode?: string;
            pages: Array<{
                options: {matchPageSize: boolean} & Record<string, unknown>;
                documentPrior?: unknown
            }>;
        };
        previewMatchPageSize = manifest.pages[0]?.options.matchPageSize;
        previewOptions = manifest.pages[0]?.options;
        previewMode = manifest.renderMode === 'preview';
        previewDocumentPrior = manifest.pages[0]?.documentPrior;
        await runSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);
    const result = await previewOf(service, sender(), {
        ...request,
        documentPrior,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        pagePlanEvidence: {
            pageNumber: requirePageNumber(1),
            rotationDegrees: 0,
            layoutClassification: 'single-uncut-page',
            outputs: {full: {
                contentBox: {
                    xNormalized: 0.1,
                    yNormalized: 0.2,
                    widthNormalized: 0.7,
                    heightNormalized: 0.6,
                    rotationDegrees: 0,
                },
                detectedSkewDegrees: -0.2,
            }},
        },
    });
    expect(deps.runSidecar).toHaveBeenCalledOnce();
    expect(previewMatchPageSize).toBe(true);
    expect(previewMode).toBe(true);
    expect(previewDocumentPrior).toEqual(documentPrior);
    expect(previewOptions).toMatchObject({
        layout: 'force-single',
        automaticContentBoxes: {full: {
            xNormalized: 0.1,
            yNormalized: 0.2,
            widthNormalized: 0.7,
            heightNormalized: 0.6,
            rotationDegrees: 0,
        }},
        automaticSkewDegrees: {full: -0.2},
    });
    await service.dispose();
    await expect(readdir(dir)).resolves.toHaveLength(0);
    expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
        pageNumber: 1,
        totalPages: 3,
        rawWidthPx: 1,
        rawHeightPx: 1,
        outputs: [{metadata: {
            half: 'full',
            skewConfidence: 2.4,
            illuminationNormalized: true,
            despeckleFallback: true,
            contentDiagnostics: {
                sideConfidence: {left: 0.7},
                textMask: {lineCount: 1},
                acceptedTrims: [{
                    side: 'top',
                    iteration: 1,
                    removedBlocks: [{pictureMaskOverlapPixels: 0}],
                }],
                protectedBlocks: [{
                    pictureMaskOverlapPixels: 1,
                    headingEvidence: true,
                }],
            },
            textToneDiagnostics: {
                applied: true,
                rule: 'applied',
                inkAnchor: 133,
                outsideMidtoneLargestComponentHeightFraction: 0.01,
            },
        }}],
        pageMetadata: {
            skewConfidence: 2.4,
            recommendedOutputModeReason: 'text-with-pictures',
            outputDiagnostics: [{
                half: 'full',
                contentDiagnostics: {
                    sideConfidence: {left: 0.7},
                    acceptedTrims: [{side: 'top'}],
                    protectedBlocks: [{headingEvidence: true}],
                },
                textToneDiagnostics: {
                    rule: 'applied',
                    inkAnchor: 133,
                },
            }],
        },
    });
    expect(() => decodeScanCleanupPreviewResult({
        ...result,
        outputs: [{
            ...result.outputs[0]!,
            metadata: {
                ...result.outputs[0]!.metadata,
                textToneDiagnostics: {
                    ...result.outputs[0]!.metadata.textToneDiagnostics!,
                    pictureFraction: 1.1,
                },
            },
        }],
    })).toThrow('text-tone');

}

export async function scenarioDoesNotUpscaleAProven72DPIRasterDocumentForItsBasePreview(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(page => ({
        ...page,
        dominantImageWidthPx: 612,
        dominantImageHeightPx: 792,
        dominantImageWidthPoints: 612,
        dominantImageHeightPoints: 792,
    })));
    const originalSidecar = deps.runSidecar;
    let manifest: {
        documentCanvas?: {
            widthPx: number;
            heightPx: number
        };
        pages: Array<{options: {
            dpi: number;
            sourceDpi: number;
            requestedRenderDpi: number
        }}>;
    } | null = null;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });

    expect(vi.mocked(deps.renderPage).mock.calls[0]?.[5]).toBe(72);
    expect(manifest).toMatchObject({
        documentCanvas: {
            widthPx: 612,
            heightPx: 792,
        },
        pages: [{options: {
            dpi: 72,
            sourceDpi: 72,
            requestedRenderDpi: 72,
        }}],
    });

}

export async function scenarioBoundsAPhysicallyOversizedScanPreviewBeforePopplerRasterizesIt(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 1);
    deps.getPageSizeStore = vi.fn(async () => createArrayBackedPdfPageSizeStore([{
        pageNumber: 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 4_676,
        heightPoints: 3_328,
        rotation: 0,
        dominantImageWidthPx: 4_676,
        dominantImageHeightPx: 3_328,
        dominantImageWidthPoints: 4_676,
        dominantImageHeightPoints: 3_328,
    }]));
    const originalSidecar = deps.runSidecar;
    let manifest: {
        documentCanvas?: {
            widthPx: number;
            heightPx: number
        };
        pages: Array<{options: {
            dpi: number;
            sourceDpi: number;
            requestedRenderDpi: number
        }}>;
    } | null = null;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        layoutByPage: {'1': 'single-uncut-page'},
    });
    // The raster is what the pixel budget bounds: this sheet is rendered
    // at half the resolution it asks for so Poppler never materializes a
    // 15-megapixel preview.
    expect(vi.mocked(deps.renderPage).mock.calls[0]?.[5]).toBe(36);
    expect(4_676 / 72 * 36 * (3_328 / 72 * 36)).toBeLessThanOrEqual(4_000_000);
    // The document canvas is not bounded by that raster: it is the page
    // the run will produce, sampled at the document's own resolution, so
    // every placement decision on it lands where the output lands it.
    expect(manifest).toMatchObject({
        documentCanvas: {
            widthPx: 4_676,
            heightPx: 3_328,
        },
        pages: [{options: {
            dpi: 72,
            sourceDpi: 72,
            requestedRenderDpi: 72,
        }}],
    });

}

export async function scenarioStreamsTheDisplayRasterButCleansBinaryPreviewTextOnTheSourceGrid(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({
        pages: [1],
        sourceDpiByPage: new Map([[
            1,
            300,
        ]]),
    }));
    const renderDpis: number[] = [];
    deps.renderPage = vi.fn(async (
        _paths,
        _log,
        _page,
        _source,
        outputPath,
        dpi,
    ) => {
        renderDpis.push(dpi);
        await writeFile(`${outputPath.replace(/\.png$/u, '')}.png`, PNG);
    });
    let manifestDpi: number | undefined;
    let manifestAnalysisDpi: number | undefined;
    let routingUsesCanonicalInput = false;
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            inputPath: string;
            analysisInputPath?: string;
            analysisDpi?: number;
            options: {dpi: number}
        }>;};
        manifestDpi = manifest.pages[0]?.options.dpi;
        manifestAnalysisDpi = manifest.pages[0]?.analysisDpi;
        routingUsesCanonicalInput = manifest.pages[0]?.analysisInputPath !== manifest.pages[0]?.inputPath;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        layoutDetectionComplete: true,
    });

    expect(renderDpis).toEqual([
        150,
        300,
    ]);
    expect(manifestDpi).toBe(300);
    expect(manifestAnalysisDpi).toBe(150);
    expect(routingUsesCanonicalInput).toBe(true);

}

export async function scenarioRendersOnlyTheRequestedZoomRegionAtTrueOutputDPIWithinTheTileBudget(): Promise<void> {

    const {deps} = await previewDependencies();
    const renderCalls: Array<{
        dpi: number;
        crop?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    }> = [];
    deps.detectSourceDpi = vi.fn(async () => 300);
    deps.renderPage = vi.fn(async (
        _paths,
        _log,
        _page,
        _source,
        outputPath,
        dpi,
        _environment,
        _signal,
        crop,
    ) => {
        renderCalls.push({
            dpi,
            ...(crop === undefined ? {} : {crop}),
        });
        await writeFile(outputPath, pngWithDimensions(
            crop?.width ?? Math.round(1_000 * dpi / 150),
            crop?.height ?? Math.round(1_500 * dpi / 150),
        ));
    });
    deps.renderPagePpm = vi.fn(async (
        _paths,
        _log,
        _page,
        _source,
        outputPath,
        dpi,
        _environment,
        _signal,
        crop,
    ) => {
        renderCalls.push({
            dpi,
            ...(crop === undefined ? {} : {crop}),
        });
        await writeFile(outputPath, ppmWithDimensions(
            crop?.width ?? Math.round(1_000 * dpi / 150),
            crop?.height ?? Math.round(1_500 * dpi / 150),
        ));
    });
    const originalSidecar = deps.runSidecar;
    let manifestOptions: Record<string, unknown> | undefined;
    let detailPlan: TDetailPreviewManifest['pages'][number]['detailRenderPlan'];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TDetailPreviewManifest;
        manifestOptions = manifest.pages[0]?.options;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
        const output = manifest.pages[0]!.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
        detailPlan = manifest.pages[0]?.detailRenderPlan;
        if (!detailPlan) {
            await writeFile(output.outputPath, pngWithDimensions(1_000, 1_500));
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_000,
                    heightPx: 1_500,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_000,
                    heightPx: 1_500,
                },
                outputWidthPx: 1_000,
                outputHeightPx: 1_500,
                canvasWidthPx: 1_000,
                canvasHeightPx: 1_500,
                inputWidthPx: 1_000,
                inputHeightPx: 1_500,
            }));
            return;
        }
        const region = detailPlan.renderRegion;
        const renderDpi = Number(manifestOptions?.dpi ?? 150);
        const outputWidthPx = Math.round(1_000 * renderDpi / 150);
        const outputHeightPx = Math.round(1_500 * renderDpi / 150);
        await writeFile(output.outputPath, pngWithDimensions(region.widthPx, region.heightPx));
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx,
            outputHeightPx,
            canvasWidthPx: outputWidthPx,
            canvasHeightPx: outputHeightPx,
            sourceDpi: 300,
            renderDpi,
            requestedRenderDpi: Number(manifestOptions?.requestedRenderDpi ?? renderDpi),
            renderRegion: region,
        }));
    });

    const service = createRenderingScenarioOwner(deps);
    const previewSender = sender();
    const matchedRequest = {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    };
    await previewOf(service, previewSender, matchedRequest);
    const result = await previewOf(service, previewSender, {
        ...matchedRequest,
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

    expect(renderCalls).toHaveLength(2);
    expect(renderCalls[0]).toEqual({dpi: 150});
    expect(renderCalls[1]).toMatchObject({
        dpi: 511,
        crop: {
            x: expect.any(Number),
            y: expect.any(Number),
            width: expect.any(Number),
            height: expect.any(Number),
        },
    });
    expect(renderCalls[1]!.crop!.width * renderCalls[1]!.crop!.height)
        .toBeLessThan(4_000 * 6_000);
    expect(result.rawWidthPx * result.rawHeightPx).toBeLessThanOrEqual(4_000_000);
    const detailPng = new DataView(
        result.outputs[0]!.imageData.buffer,
        result.outputs[0]!.imageData.byteOffset,
        result.outputs[0]!.imageData.byteLength,
    );
    expect(detailPng.getUint32(16) * detailPng.getUint32(20)).toBeLessThanOrEqual(4_000_000);
    expect(manifestOptions).toMatchObject({
        sourceDpi: 300,
        dpi: 511,
        requestedRenderDpi: 600,
        outputMode: 'bw',
        matchPageSize: false,
    });
    expect(manifestOptions).not.toHaveProperty('renderCrop');
    expect(detailPlan?.sourceCrop).toEqual({
        xPx: renderCalls[1]!.crop!.x,
        yPx: renderCalls[1]!.crop!.y,
        widthPx: renderCalls[1]!.crop!.width,
        heightPx: renderCalls[1]!.crop!.height,
    });
    const detailedWidth = Math.round(1_000 * 511 / 150);
    const detailedHeight = Math.round(1_500 * 511 / 150);
    expect(detailPlan!.renderRegion.widthPx / detailedWidth)
        .toBeLessThanOrEqual(0.5 + 1 / detailedWidth);
    expect(detailPlan!.renderRegion.heightPx / detailedHeight)
        .toBeLessThanOrEqual(0.45 + 1 / detailedHeight);
    expect(
        (detailPlan!.renderRegion.xPx + detailPlan!.renderRegion.widthPx / 2) / detailedWidth,
    ).toBeCloseTo(0.5, 2);
    expect(
        (detailPlan!.renderRegion.yPx + detailPlan!.renderRegion.heightPx / 2) / detailedHeight,
    ).toBeCloseTo(0.425, 2);
    expect(result.outputs[0]?.metadata).toMatchObject({
        renderDpi: 511,
        requestedRenderDpi: 600,
        renderRegion: {
            xPx: expect.any(Number),
            yPx: expect.any(Number),
            widthPx: expect.any(Number),
            heightPx: expect.any(Number),
        },
    });

    const budgetedResult = await previewOf(service, previewSender, {
        ...matchedRequest,
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
    });
    expect(renderCalls[2]?.dpi).toBe(242);
    expect(manifestOptions).toMatchObject({
        dpi: 242,
        sourceDpi: 300,
        requestedRenderDpi: 600,
    });
    expect(detailPlan?.renderRegion).toEqual({
        xPx: 0,
        yPx: 0,
        widthPx: 1_613,
        heightPx: 2_420,
    });
    expect(budgetedResult.outputs[0]?.metadata).toMatchObject({
        outputWidthPx: 1_613,
        outputHeightPx: 2_420,
        renderDpi: 242,
        requestedRenderDpi: 600,
        renderRegion: {
            xPx: 0,
            yPx: 0,
            widthPx: 1_613,
            heightPx: 2_420,
        },
    });

    const mixedFallback = await previewOf(service, previewSender, {
        ...matchedRequest,
        detail: {
            viewports: {full: {
                xNormalized: 0.25,
                yNormalized: 0.2,
                widthNormalized: 0.5,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'mixed',
        },
    });
    expect(renderCalls[3]).toEqual({dpi: 204});
    expect(detailPlan).toBeUndefined();
    expect(manifestOptions).toMatchObject({
        dpi: 204,
        sourceDpi: 300,
        requestedRenderDpi: 600,
        outputMode: 'mixed',
    });
    expect(mixedFallback.outputs).toHaveLength(1);
    expect(mixedFallback.outputs[0]?.metadata.renderRegion).toBeUndefined();

    const manualZoneOptions = {
        ...request.options,
        pageOverrides: {'1': {
            rotationDegrees: 0 as const,
            layoutOverride: 'auto' as const,
            excluded: false,
            manualSplit: null,
            manualZones: {
                picture: [{
                    layer: 'painter2' as const,
                    polygon: {
                        points: [
                            {
                                xNormalized: 0.25,
                                yNormalized: 0.25,
                            },
                            {
                                xNormalized: 0.75,
                                yNormalized: 0.25,
                            },
                            {
                                xNormalized: 0.75,
                                yNormalized: 0.75,
                            },
                        ],
                        rotationDegrees: 0 as const,
                    },
                }],
                fill: [],
            },
        }},
    };
    await previewOf(service, previewSender, {
        ...matchedRequest,
        options: manualZoneOptions,
    });
    const manualZoneFallback = await previewOf(service, previewSender, {
        ...matchedRequest,
        options: manualZoneOptions,
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
    expect(renderCalls).toHaveLength(4);
    expect(detailPlan).toBeUndefined();
    expect(manualZoneFallback).not.toHaveProperty('rawImageData');
    expect(manifestOptions).toMatchObject({
        dpi: 204,
        outputMode: 'bw',
    });
    expect(manualZoneFallback.outputs[0]?.metadata.renderRegion).toBeUndefined();

}

export async function scenarioHandsTheDetailTileToTheSidecarThroughTheSharedRasterHandoff(): Promise<void> {

    const {
        dir,
        deps,
    } = await previewDependencies();
    deps.detectSourceDpi = vi.fn(async () => 300);
    deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath, dpi, _environment, _signal, crop) => {
        await writeFile(outputPath, pngWithDimensions(
            crop?.width ?? Math.round(1_000 * dpi / 150),
            crop?.height ?? Math.round(1_500 * dpi / 150),
        ));
    });
    const originalSidecar = deps.runSidecar;
    let detailPlan: TDetailPreviewManifest['pages'][number]['detailRenderPlan'];
    let tileInputPath: string | undefined;
    let tileInputBytes: Buffer | undefined;
    let baseCleanedRasterBytes: Buffer | undefined;
    const baseMetadataPaths: string[] = [];
    const baseCleanedRasterPaths: string[] = [];
    const sidecarRoots: Array<string | undefined> = [];
    const detailManifestPaths: string[] = [];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress, options) => {
        sidecarRoots.push(options?.allowedPathRoot);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TDetailPreviewManifest & {pages: Array<{inputPath: string}>;};
        await originalSidecar(binary, manifestPath, signal, log, onProgress, options);
        const page = manifest.pages[0]!;
        const output = page.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
        detailPlan = page.detailRenderPlan;
        if (!detailPlan) {
            await writeFile(output.outputPath, pngWithDimensions(1_000, 1_500));
            await writeFile(output.metadataPath, JSON.stringify({
                ...metadata,
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_000,
                    heightPx: 1_500,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_000,
                    heightPx: 1_500,
                },
                outputWidthPx: 1_000,
                outputHeightPx: 1_500,
                canvasWidthPx: 1_000,
                canvasHeightPx: 1_500,
                inputWidthPx: 1_000,
                inputHeightPx: 1_500,
            }));
            return;
        }
        detailManifestPaths.push(manifestPath);
        if (detailPlan.baseMetadataPath !== undefined) baseMetadataPaths.push(detailPlan.baseMetadataPath);
        if (detailPlan.baseCleanedRasterPath !== undefined) {
            baseCleanedRasterPaths.push(detailPlan.baseCleanedRasterPath);
        }
        tileInputPath = page.inputPath;
        tileInputBytes = await readFile(page.inputPath);
        baseCleanedRasterBytes = detailPlan.baseCleanedRasterPath
            ? await readFile(detailPlan.baseCleanedRasterPath)
            : undefined;
        const region = detailPlan.renderRegion;
        await writeFile(output.outputPath, pngWithDimensions(region.widthPx, region.heightPx));
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx: 4_000,
            outputHeightPx: 6_000,
            canvasWidthPx: 4_000,
            canvasHeightPx: 6_000,
            sourceDpi: 300,
            renderDpi: 300,
            requestedRenderDpi: 300,
            renderRegion: region,
        }));
    });

    const service = createRenderingScenarioOwner(deps);
    const previewSender = sender();
    const baseResult = await previewOf(service, previewSender, request);
    const result = await previewOf(service, previewSender, {
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

    // Both lanes have to have produced something first. The base raster and
    // the render region below are compared against the plan the detail lane
    // published, and two absent values agree with each other.
    expect(baseResult.outputs).not.toHaveLength(0);
    expect(result.outputs).not.toHaveLength(0);
    expect(detailPlan).toBeDefined();
    // The tile crop is sidecar input only: it reaches native raw, and the
    // dimensions the render plan carries come from that raw header.
    expect(tileInputPath).toMatch(/\.ppm$/);
    const decoded = decodePpm(tileInputBytes!);
    expect(detailPlan?.sourceCrop).toMatchObject({
        widthPx: decoded.width,
        heightPx: decoded.height,
    });
    expect(decoded.pixels.equals(rasterPixels(decoded.width, decoded.height))).toBe(true);
    expect(detailPlan?.baseCleanedRasterPath).toMatch(/\.png$/);
    expect(baseCleanedRasterBytes).toEqual(
        Buffer.from(baseResult.outputs[0]!.imageData),
    );
    expect(result).not.toHaveProperty('rawImageData');
    expect(vi.mocked(deps.renderPagePpm).mock.calls).toHaveLength(1);
    expect(vi.mocked(deps.renderPagePpm).mock.calls[0]?.[8]).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
        width: decoded.width,
        height: decoded.height,
    });
    // The base page still renders in the format the renderer displays.
    expect(vi.mocked(deps.renderPage).mock.calls.map(call => call[8])).toEqual([undefined]);
    expect(result.outputs[0]?.metadata.renderRegion).toEqual(detailPlan?.renderRegion);

    const secondDetail = await previewOf(service, previewSender, {
        ...request,
        requestId: requireRequestId('detail-second-tile'),
        detail: {
            viewports: {full: {
                xNormalized: 0.5,
                yNormalized: 0.2,
                widthNormalized: 0.25,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    });

    expect(secondDetail).not.toHaveProperty('rawImageData');
    expect(deps.detectSourceDpi).toHaveBeenCalledOnce();
    expect(vi.mocked(deps.renderPagePpm).mock.calls).toHaveLength(2);
    expect(baseMetadataPaths).toHaveLength(2);
    expect(baseCleanedRasterPaths).toHaveLength(2);
    expect(new Set(baseMetadataPaths).size).toBe(1);
    expect(new Set(baseCleanedRasterPaths).size).toBe(1);
    // Every product sidecar call — ordinary preview and detail alike —
    // constrains native to the injected temp root, and the builder that
    // wrote each manifest checked its paths against that same root.
    expect(sidecarRoots.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sidecarRoots)).toEqual(new Set([dir]));
    // The retained base-analysis raster a detail tile reuses sits beside
    // the detail scratch, not inside it: the wider temp root is what keeps
    // it admissible.
    expect(isPathWithinRoot(baseCleanedRasterPaths[0]!, dir)).toBe(true);
    expect(detailManifestPaths.length).toBeGreaterThan(0);
    expect(isPathWithinRoot(baseCleanedRasterPaths[0]!, dirname(detailManifestPaths[0]!))).toBe(false);
    await service.dispose();
    await expect(stat(baseCleanedRasterPaths[0]!)).rejects.toMatchObject({code: 'ENOENT'});

}

export async function scenarioKeepsARecentlyReadBaseAnalysisWhilePruningAStaleEntry(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 33);
    const service = createRenderingScenarioOwner(deps);
    const previewSender = sender();
    const baseRequest = {
        ...request,
        options: {
            ...request.options,
            matchPageSize: false,
        },
    };
    const detailRequest = (pageNumber: number, requestId: string): IScanCleanupPreviewRequest => ({
        ...baseRequest,
        pageNumber: requirePageNumber(pageNumber),
        requestId: requireRequestId(requestId),
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
    });

    for (let pageNumber = 1; pageNumber <= 32; pageNumber += 1) {
        await previewOf(service, previewSender, {
            ...baseRequest,
            pageNumber: requirePageNumber(pageNumber),
            requestId: requireRequestId(`base-${String(pageNumber)}`),
        });
    }
    await expect(previewOf(service, previewSender, detailRequest(1, 'touch-page-1')))
        .resolves.toMatchObject({pageNumber: 1});
    await previewOf(service, previewSender, {
        ...baseRequest,
        pageNumber: requirePageNumber(33),
        requestId: requireRequestId('base-33'),
    });

    await expect(previewOf(service, previewSender, detailRequest(1, 'verify-page-1')))
        .resolves.toMatchObject({pageNumber: 1});
    await expect(previewOf(service, previewSender, detailRequest(2, 'verify-page-2')))
        .rejects.toThrow('detail geometry is unavailable');
    await service.dispose();

}

export async function scenarioProbesOnlyTheRequestedPageForTheFirstPreviewRasterStructure(): Promise<void> {

    const {deps} = await previewDependencies();
    const probedPages: number[][] = [];
    deps.detectRasterPages = vi.fn(async (_sourcePdfPath, _signal, pageNumbers) => {
        probedPages.push([...pageNumbers]);
        return createScanCleanupPageRasterSource({pages: pageNumbers});
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), request);

    expect(deps.detectRasterPages).toHaveBeenCalledOnce();
    expect(probedPages).toEqual([[1]]);

}

export async function scenarioKeepsIntrinsicPageCanvasesWhenTheDocumentGeometryCannotBeRead(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageSizes = vi.fn(async () => []);
    const originalSidecar = deps.runSidecar;
    let matchPageSize: boolean | undefined;
    let documentCanvas: unknown;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: Array<{options: {matchPageSize: boolean}}>;
        };
        matchPageSize = manifest.pages[0]?.options.matchPageSize;
        documentCanvas = manifest.documentCanvas;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    const result = await previewOf(createRenderingScenarioOwner(deps), sender(), request);

    expect(matchPageSize).toBe(false);
    expect(documentCanvas).toBeUndefined();
    expect(result.outputs[0]?.metadata).toMatchObject({
        canvasWidthPx: 1,
        canvasHeightPx: 1,
    });

}

export async function scenarioPresentsAClassifiedSpreadOnAHalfSheetCanvasWithoutForcingAnUnmeasuredCut(): Promise<void> {

    const {deps} = await previewDependencies();
    // A document of spread sheets: every sheet carries two book pages.
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(pageSize => ({
        ...pageSize,
        widthPoints: 1_224,
    })));
    const originalSidecar = deps.runSidecar;
    let documentCanvas: unknown;
    let observedPageLayout: unknown;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: Array<{options: {layout: string}}>;
        };
        documentCanvas = manifest.documentCanvas;
        observedPageLayout = manifest.pages[0]?.options.layout;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);

    // Nothing has classified the document yet. The authoritative planner
    // still treats each unknown as a whole sheet, but the provisional
    // preview stays intrinsic rather than presenting that conservative
    // landscape frame as the cleaned page size.
    await previewOf(service, sender(), request);
    expect(documentCanvas).toBeUndefined();

    // Once the caller knows these are spreads, the frame is the half sheet
    // each output actually carries. The classification is sufficient for
    // document-canvas geometry, but it must not become a destructive
    // force-two-page instruction without the measured cutter evidence.
    await previewOf(service, sender(), {
        ...request,
        pageNumber: requirePageNumber(2),
        layoutByPage: {
            '1': 'two-page-spread',
            '2': 'two-page-spread',
            '3': 'two-page-spread',
        },
    });
    // The grid is the document's own resolution. The sheet these halves
    // come from is rendered below it so its raster stays inside the
    // preview pixel budget, but that bound belongs to the raster and not
    // to the rectangle the run will produce.
    expect(documentCanvas).toEqual({
        widthPoints: 612,
        heightPoints: 792,
        widthPx: 1_275,
        heightPx: 1_650,
    });
    expect(observedPageLayout).toBe('auto');

}

export async function scenarioReusesTheDetectedOutputModeForAnAutomaticPreview(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    let outputMode: unknown;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{options: {outputMode: string}}>;};
        outputMode = manifest.pages[0]?.options.outputMode;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'bw',
    });

    expect(outputMode).toBe('bw');

}

export async function scenarioDoesNotTurnACanceledTrustedLayerExtractionIntoARasterFallback(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({
        pages: [1],
        bilevelLayerPages: [1],
        backgroundDpiByPage: new Map([[
            1,
            100,
        ]]),
    }));
    const extractionEntered = Promise.withResolvers<undefined>();
    deps.extractMrcLayers = vi.fn(async (
        _sourcePdfPath,
        _pageNumber,
        _selectionMaskOutputPath,
        _backgroundOutputPath,
        signal,
    ) => {
        extractionEntered.resolve(undefined);
        await waitForRelease(Promise.withResolvers<never>().promise, signal);
        return null;
    });
    deps.runSidecar = vi.fn(async () => undefined);
    const service = createRenderingScenarioOwner(deps);
    const previewSender = sender();
    const pending = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'mixed',
    });
    await extractionEntered.promise;

    expect(service.cancel(previewSender, request)).toBe(true);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(deps.runSidecar).not.toHaveBeenCalled();

}

export async function scenarioReusesBaseGeometryForDetailAfterDetectionResolvesAuto(): Promise<void> {

    const {service} = await previewFixture();
    const previewSender = sender();
    const automaticRequest = {
        ...request,
        requestId: requireRequestId('recommended-base'),
        options: {
            ...request.options,
            outputMode: 'auto' as const,
        },
        outputModeRecommendation: 'color' as const,
    };
    await previewOf(service, previewSender, automaticRequest);
    const {
        outputModeRecommendation: _outputModeRecommendation,
        ...detailBase
    } = automaticRequest;

    await expect(previewOf(service, previewSender, {
        ...detailBase,
        requestId: requireRequestId('recommended-detail'),
        detail: {
            viewports: {full: {
                xNormalized: 0,
                yNormalized: 0,
                widthNormalized: 1,
                heightNormalized: 1,
                rotationDegrees: 0,
            }},
            outputMode: 'color',
        },
    })).resolves.toMatchObject({
        pageNumber: 1,
        outputs: [{metadata: {outputMode: 'color'}}],
    });

}

export async function scenarioRendersAMatchedLosslessPageTheFinalRunCannotKeepLossless(): Promise<void> {

    const {deps} = await previewDependencies();
    // The document was scanned at two scales, and both pages carry their own
    // raster: matched page size cannot put them on one grid without
    // re-rendering, so the run will render — and so must the preview.
    deps.getPageSizeStore = vi.fn(async () => createArrayBackedPdfPageSizeStore([
        {
            pageNumber: 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        },
        {
            pageNumber: requirePageNumber(2),
            xPoints: 0,
            yPoints: 0,
            widthPoints: 306,
            heightPoints: 396,
            rotation: 0,
        },
        {
            pageNumber: requirePageNumber(3),
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
        },
    ]));
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({pages: [
        1,
        2,
    ]}));
    const originalSidecar = deps.runSidecar;
    const operations: Array<string | undefined> = [];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {operation?: string};
        operations.push(manifest.operation);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const losslessRequest = {
        ...request,
        options: {
            ...request.options,
            preserveOriginalQuality: true,
        },
    };

    const result = await previewOf(createRenderingScenarioOwner(deps), sender(), losslessRequest);

    // A cleaned raster, not an analysis-only answer that shows the page as
    // it arrived and calls that the output.
    expect(operations).toEqual(['render']);
    expect(result.outputs[0]?.metadata).toMatchObject({canvasScope: 'page'});
    expect(deps.detectRasterPages).toHaveBeenCalledOnce();
    expect(deps.detectRasterPages).toHaveBeenCalledWith(
        request.sourcePdfPath,
        expect.any(AbortSignal),
        [
            1,
            2,
            3,
        ],
    );

}

export async function scenarioKeepsAMatchedLosslessPageLosslessWhenTheDocumentSharesOneGrid(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({pages: [
        1,
        2,
        3,
    ]}));
    const originalSidecar = deps.runSidecar;
    const operations: Array<string | undefined> = [];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {operation?: string};
        operations.push(manifest.operation);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        options: {
            ...request.options,
            preserveOriginalQuality: true,
        },
    });

    // Every page of this document is the canvas already, so nothing has to
    // be resampled and the original pixels are what the run will publish.
    expect(operations).toEqual(['analyze']);

}

export async function scenarioUsesAnalysisOnlyOutputMetadataForTheLosslessOriginalPagePreview(): Promise<void> {

    const {deps} = await previewDependencies();
    let manifestOptions: Record<string, unknown> | null = null;
    let classifyOnly = false;
    deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation?: string;
            pages: Array<{
                pageMetadataPath: string;
                options: Record<string, unknown>;
            }>;
        };
        classifyOnly = manifest.operation === 'analyze';
        manifestOptions = manifest.pages[0]!.options;
        await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
            canvasScope: 'page',
            layoutClassification: 'two-page-spread',
            layoutConfidence: 0.94,
            cutterXPx: 1,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 2,
            outputs: [
                {
                    half: 'left',
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 120,
                        heightPx: 80,
                    },
                    contentBox: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 120,
                        heightPx: 80,
                    },
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 120,
                        heightPx: 80,
                    },
                    appliedMargins: {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    },
                    inputWidthPx: 120,
                    inputHeightPx: 80,
                },
                {
                    half: 'right',
                    sourceRegion: {
                        xPx: 1,
                        yPx: 0,
                        widthPx: 1,
                        heightPx: 1,
                    },
                    contentBox: null,
                    cropRect: {
                        xPx: 1,
                        yPx: 0,
                        widthPx: 1,
                        heightPx: 1,
                    },
                    appliedMargins: {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    },
                    inputWidthPx: 2,
                    inputHeightPx: 1,
                },
            ],
        }));
    });

    const result = await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        options: {
            ...request.options,
            preserveOriginalQuality: true,
            thickness: 4,
            skipBlankPages: true,
        },
    });

    expect(classifyOnly).toBe(true);
    expect(manifestOptions).toMatchObject({
        outputMode: 'color',
        thickness: 0,
        despeckle: false,
        skipBlankPages: false,
        experimental: {autoDewarp: false},
    });
    // The matched canvas is the document-wide plan at preview DPI, the same
    // rectangle for both halves and for every other page.
    expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [
        {metadata: {
            half: 'left',
            canvasWidthPx: DOCUMENT_CANVAS.widthPx,
            canvasHeightPx: DOCUMENT_CANVAS.heightPx,
            outputWidthPx: 120,
            outputHeightPx: 80,
            // The original objects are scaled without resampling, but the
            // five-millimetre final-canvas inset is reserved first. At
            // preview DPI that leaves 1215 px across; aspect ratio keeps
            // this 120x80 half at 1215x810 inside the boundary.
            matchedCanvasContentWidthPx: 1_215,
            matchedCanvasContentHeightPx: 810,
            appliedMargins: {
                leftPx: 30,
                topPx: 30,
                rightPx: 30,
                bottomPx: 30,
            },
            resamplePasses: 0,
        }},
        {metadata: {
            half: 'right',
            resamplePasses: 0,
        }},
    ]});

}

export async function scenarioUsesThePairWideLosslessFitWhenOneSpreadLeafReachesTheMarginBox(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageSizes = vi.fn(async () => [
        1,
        2,
        3,
    ].map(pageNumber => ({
        pageNumber,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 1_057.44,
        heightPoints: 780.48,
        rotation: 0,
    })));
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({pages: [
        1,
        2,
        3,
    ]}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>};
        const output = (
            half: 'left' | 'right',
            sourceX: number,
            sourceWidth: number,
            cropWidth: number,
            cropHeight: number,
        ) => ({
            half,
            sourceRegion: {
                xPx: sourceX,
                yPx: 0,
                widthPx: sourceWidth,
                heightPx: 1_573,
            },
            contentBox: {
                xPx: 0,
                yPx: 0,
                widthPx: cropWidth,
                heightPx: cropHeight,
            },
            cropRect: {
                xPx: 0,
                yPx: 0,
                widthPx: cropWidth,
                heightPx: cropHeight,
            },
            appliedMargins: {
                leftPx: 0,
                topPx: 0,
                rightPx: 0,
                bottomPx: 0,
            },
            inputWidthPx: 2_203,
            inputHeightPx: 1_573,
        });
        await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
            canvasScope: 'page',
            layoutClassification: 'two-page-spread',
            layoutConfidence: 0.94,
            cutterXPx: 1_198,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 2,
            outputs: [
                output('left', 0, 1_198, 876, 1_407),
                output('right', 1_198, 1_005, 607, 1_573),
            ],
        }));
    });

    const result = decodeScanCleanupPreviewResult(await previewOf(
        createRenderingScenarioOwner(deps),
        sender(),
        {
            ...request,
            layoutByPage: {
                '1': 'two-page-spread',
                '2': 'two-page-spread',
                '3': 'two-page-spread',
            },
            options: {
                ...request.options,
                preserveOriginalQuality: true,
            },
        },
    ));
    if (!('outputs' in result)) {
        throw new Error('Expected a completed asymmetric-spread preview');
    }
    const [
        left,
        right,
    ] = result.outputs.map(output => output.metadata);

    expect(left!.canvasWidthPx).toBe(right!.canvasWidthPx);
    expect(left!.canvasHeightPx).toBe(right!.canvasHeightPx);
    expect(left!.matchedCanvasContentHeightPx! / 1_407)
        .toBeCloseTo(right!.matchedCanvasContentHeightPx! / 1_573, 3);
    expect(left!.matchedCanvasContentWidthPx! / 876)
        .toBeCloseTo(right!.matchedCanvasContentWidthPx! / 607, 3);
    expect(left!.matchedCanvasContentHeightPx).toBeLessThan(1_407);
    expect(right!.matchedCanvasContentHeightPx).toBe(1_566);

}

export async function scenarioReservesExactFinalCanvasMarginsInAMatchedLosslessPreviewAndSaysWhenContentIsFitted(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
        await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
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
                // The engine reports content without pre-scaling its
                // margins; the preview owns the final matched sheet.
                sourceRegion: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 120,
                    heightPx: 80,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 120,
                    heightPx: 80,
                },
                cropRect: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 120,
                    heightPx: 80,
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                inputWidthPx: 120,
                inputHeightPx: 80,
            }],
        }));
    });

    const result = await previewOf(createRenderingScenarioOwner(deps), sender(), {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        options: {
            ...request.options,
            preserveOriginalQuality: true,
        },
    });

    const metadata = decodeScanCleanupPreviewResult(result);
    const outputs = 'outputs' in metadata ? metadata.outputs : [];
    // An empty result would satisfy every assertion below by never reaching
    // one, so the page is proved to carry its output before it is indexed.
    expect(outputs).not.toHaveLength(0);
    const output = outputs[0]!.metadata;
    // The page rectangle stays fixed and content is fitted inside the
    // 5 mm boundary, which is the same geometry the final assembler uses.
    expect(output).toMatchObject({
        canvasWidthPx: DOCUMENT_CANVAS.widthPx,
        canvasHeightPx: DOCUMENT_CANVAS.heightPx,
        canvasOverflow: true,
        appliedMargins: {
            leftPx: 30,
            topPx: 30,
            rightPx: 30,
            bottomPx: 30,
        },
    });
    expect(output.matchedCanvasContentWidthPx).toBe(DOCUMENT_CANVAS.widthPx - 60);
    // The lossless preview reports the fitted placement through the shared
    // code, so the sentence it shows is the final run's sentence. Its
    // extents are stated outright rather than read back from the metadata
    // under test: the 120x80 source fills the inner box's width and keeps
    // its 3:2 aspect down the page. It also names the document canvas the
    // margin box was cut out of, which is what the raster path reports for
    // the same placement.
    expect(output.warnings).toEqual([formatScanCleanupWarningEvent({
        code: 'matched-canvas-content-fitted',
        unit: 'px',
        contentWidth: 1_215,
        contentHeight: 810,
        innerWidth: DOCUMENT_CANVAS.widthPx - 60,
        innerHeight: DOCUMENT_CANVAS.heightPx - 60,
        documentCanvasWidth: DOCUMENT_CANVAS.widthPx,
        documentCanvasHeight: DOCUMENT_CANVAS.heightPx,
    })]);
    expect(output.matchedCanvasContentHeightPx! / output.matchedCanvasContentWidthPx!)
        .toBeCloseTo(80 / 120, 2);

}

export async function scenarioSamplesTheMatchedPreviewCanvasOnTheGridTheOutputPageCarries(): Promise<void> {

    const {deps} = await previewDependencies();
    // 142.08 pt is 296.00000000000006 px at 150 DPI: the page the run
    // produces carries 296 px, and the 25 mm margin pair the request asks
    // for is exactly that width once each margin lands on the grid.
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(pageSize => ({
        ...pageSize,
        widthPoints: 142.08,
        heightPoints: 213.12,
    })));
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({detected: true}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
        await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
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
                    widthPx: 296,
                    heightPx: 444,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 296,
                    heightPx: 444,
                },
                cropRect: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 296,
                    heightPx: 444,
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                inputWidthPx: 296,
                inputHeightPx: 444,
            }],
        }));
    });

    const result = decodeScanCleanupPreviewResult(await previewOf(
        createRenderingScenarioOwner(deps),
        sender(),
        {
            ...request,
            layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
                marginsMm: {
                    leftMm: 25,
                    topMm: 0,
                    rightMm: 25,
                    bottomMm: 0,
                },
            },
        },
    ));
    const outputs = 'outputs' in result ? result.outputs : [];
    expect(outputs).not.toHaveLength(0);
    const output = outputs[0]!.metadata;

    // The presented canvas is the page the output carries, not a rounding
    // of the document plan's own pixel counts.
    expect(output.canvasWidthPx).toBe(296);
    expect(output.canvasHeightPx).toBe(444);
    // And because the margin pair meets that canvas exactly, the preview
    // reduces it and says so — the decision the final page makes.
    expect(output.warnings).toContain(formatScanCleanupWarningEvent({code: 'matched-canvas-margins-reduced'}));
    // 25 mm rounds to 148 px on each side of this 296 px canvas, and what
    // the preview delivers is exactly what the shared margin fit answers
    // for that pair. The lossless assembler asks the same function, so
    // neither route can drift into a reduction rule of its own.
    expect([
        output.appliedMargins.leftPx,
        output.appliedMargins.rightPx,
    ]).toEqual([...fitScanCleanupMarginAxisPx(148, 148, 296)]);

}

export async function scenarioNamesPaperTheMatchedPreviewCanvasCannotHold(): Promise<void> {

    const {deps} = await previewDependencies();
    // Two landscape sheets settle the document rectangle; the portrait
    // sheet between them is the same area turned on its side, so it is
    // paper this canvas cannot hold at the document's scale.
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(pageSize => (
        pageSize.pageNumber === 2
            ? pageSize
            : {
                ...pageSize,
                widthPoints: 792,
                heightPoints: 612,
            }
    )));
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({detected: true}));
    deps.runSidecar = vi.fn(async (_binary, manifestPath) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
        await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
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
                    widthPx: 1_275,
                    heightPx: 1_650,
                },
                contentBox: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_275,
                    heightPx: 1_650,
                },
                cropRect: {
                    xPx: 0,
                    yPx: 0,
                    widthPx: 1_275,
                    heightPx: 1_650,
                },
                appliedMargins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                inputWidthPx: 1_275,
                inputHeightPx: 1_650,
            }],
        }));
    });

    const result = decodeScanCleanupPreviewResult(await previewOf(
        createRenderingScenarioOwner(deps),
        sender(),
        {
            ...request,
            pageNumber: requirePageNumber(2),
            layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
            options: {
                ...request.options,
                preserveOriginalQuality: true,
            },
        },
    ));
    const outputs = 'outputs' in result ? result.outputs : [];
    expect(outputs).not.toHaveLength(0);
    // The final run reports this condition for the same page. A preview
    // that showed the smaller placement without it left the reason to be
    // guessed.
    expect(outputs[0]!.metadata.warnings).toContain(formatScanCleanupWarningEvent({
        code: 'matched-canvas-paper-downscaled',
        unit: 'px',
        scalePercentTenths: 773,
        documentCanvasWidth: 1_650,
        documentCanvasHeight: 1_275,
    }));

}

export async function scenarioMatchesProvisionalPreviewsFromKnownPagesWithoutGuessingUnknownLayouts(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.getPageSizes = vi.fn(async () => DOCUMENT_PAGE_SIZES.map(page => ({
        ...page,
        widthPoints: page.widthPoints * 2,
    })));
    const analysis = Promise.withResolvers<undefined>();
    const previewCanvases: unknown[] = [];
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: unknown[];
        };
            // The detect-all manifest reads every page at once; anything else
            // is a preview of the page the user is looking at.
        if (manifest.pages.length > 1) {
            await waitForRelease(analysis.promise, signal);
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
            return;
        }
        previewCanvases.push(manifest.documentCanvas);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const matched = {
        ...request,
        options: {
            ...request.options,
            matchPageSize: true,
        },
    };

    // Before any detection has been asked for.
    await previewOf(service, owner, matched);
    const started = await service.detectAll(owner, {
        ...detectionRequest,
        options: matched.options,
    });
    await vi.waitFor(() => expect(
        service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
    ).toBe('running'));
    // While the job is still reading the scan.
    await previewOf(service, owner, {
        ...matched,
        pageNumber: requirePageNumber(2),
        layoutByPage: {'1': 'two-page-spread'},
    });
    // Another page's interim single verdict is only one provisional
    // outlier. It must not put the already-proven spread leaves back onto
    // the full landscape sheet.
    await previewOf(service, owner, {
        ...matched,
        pageNumber: requirePageNumber(3),
        layoutByPage: {
            '1': 'two-page-spread',
            '2': 'two-page-spread',
            '3': 'single-uncut-page',
        },
    });
    analysis.resolve(undefined);
    await vi.waitFor(() => expect(
        service.getDetectionJobState(owner, started.jobId, detectionRequest)?.status,
    ).toBe('completed'));
    // And once it has measured every content crop.
    await previewOf(service, owner, {
        ...matched,
        pageNumber: requirePageNumber(1),
        layoutDetectionComplete: true,
        layoutByPage: {
            '1': 'two-page-spread',
            '2': 'two-page-spread',
            '3': 'single-uncut-page',
        },
    });

    expect(previewCanvases).toEqual([
        undefined,
        {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_275,
            heightPx: 1_650,
        },
        {
            widthPoints: 612,
            heightPoints: 792,
            widthPx: 1_275,
            heightPx: 1_650,
        },
        {
            widthPoints: 1_224,
            heightPoints: 792,
            widthPx: 2_550,
            heightPx: 1_650,
        },
    ]);
    expect(deps.getPageSizeStore).toHaveBeenCalledOnce();
    await service.dispose();

}

export async function scenarioLeavesEveryPageItsOwnCropWhenPageSizesAreNotMatched(): Promise<void> {

    const {deps} = await previewDependencies();
    const previewCanvases: unknown[] = [];
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {documentCanvas?: unknown};
        previewCanvases.push(manifest.documentCanvas);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();

    await previewOf(service, owner, {
        ...request,
        options: {
            ...request.options,
            matchPageSize: false,
        },
    });

    expect(previewCanvases).toEqual([undefined]);
    expect(deps.getPageSizeStore).toHaveBeenCalledOnce();

}

export async function scenarioPreviewsWithoutMatchingWhenItCannotMeasureAndMeasuresAgainNextTime(): Promise<void> {

    const {deps} = await previewDependencies();
    let measurements = 0;
    deps.getPageSizes = vi.fn(async () => {
        measurements += 1;
        if (measurements === 1) throw new Error('evb-pdf-page-ops is unavailable');
        return DOCUMENT_PAGE_SIZES;
    });
    const canvases: unknown[] = [];
    const matched: Array<boolean | undefined> = [];
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: Array<{options: {matchPageSize: boolean}}>;
        };
        canvases.push(manifest.documentCanvas);
        matched.push(manifest.pages[0]?.options.matchPageSize);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();
    const settledRequest = {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    };

    // Geometry is what matching needs and the only thing that needs it, so
    // a document nothing can measure is still cleaned and previewed — with
    // matching off for the request and the page saying so, rather than the
    // whole preview failing over page sizes.
    const unmatched = await previewOf(service, owner, settledRequest);

    expect(unmatched.pageNumber).toBe(1);
    expect(matched).toEqual([false]);
    expect(canvases).toEqual([undefined]);
    expect(unmatched.outputs[0]?.metadata.warnings.some(warning => /Matched page size is off/u.test(warning)))
        .toBe(true);

    // The failure is not remembered: it was the measurement's, not the
    // document's, so the next request measures again and matches.
    const recovered = await previewOf(service, owner, settledRequest);

    expect(recovered.pageNumber).toBe(1);
    expect(canvases).toEqual([
        undefined,
        DOCUMENT_CANVAS,
    ]);
    expect(matched).toEqual([
        false,
        true,
    ]);
    expect(recovered.outputs[0]?.metadata.warnings.some(warning => /Matched page size is off/u.test(warning)))
        .toBe(false);
    expect(measurements).toBe(2);

}

export async function scenarioMeasuresUnderTheDocumentRatherThanUnderTheRequestThatAskedFirst(): Promise<void> {

    const {deps} = await previewDependencies();
    const measuring = Promise.withResolvers<undefined>();
    const releaseMeasurement = Promise.withResolvers<undefined>();
    let measurementSignal: AbortSignal | undefined;
    deps.getPageSizes = vi.fn(async (_path, measureOptions) => {
        measurementSignal = measureOptions?.signal;
        measuring.resolve(undefined);
        await releaseMeasurement.promise;
        return DOCUMENT_PAGE_SIZES;
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();
    const documentRequest = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    };

    const pending = previewOf(service, owner, {
        ...request,
        visible: true,
    });
    await measuring.promise;
    // The caller goes away; the shared measurement does not, because it is
    // the document's work rather than this request's.
    service.cancel(owner, {
        ...documentRequest,
        invalidateRawCache: false,
        retainPages: [],
    });
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(measurementSignal?.aborted).toBe(false);

    // Closing the document is what stops it, for everyone at once, without
    // any one caller having had to own the cancellation.
    service.cancel(owner, documentRequest);
    expect(measurementSignal?.aborted).toBe(true);
    releaseMeasurement.resolve(undefined);

}

export async function scenarioCarriesAPageTheEngineFittedBelowTheDocumentScaleAcrossTheBridge(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{outputs: Array<{metadataPath: string}>}>};
        const output = manifest.pages[0]!.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8')) as Record<string, unknown>;
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx: 252,
            outputHeightPx: 232,
            canvasWidthPx: 200,
            canvasHeightPx: 180,
            canvasPolicy: 'strict-maximum',
            canvasOverflow: true,
            matchedCanvasTargetWidthPx: 200,
            matchedCanvasTargetHeightPx: 180,
            matchedCanvasTargetWidthPoints: 96,
            matchedCanvasTargetHeightPoints: 86.4,
            matchedCanvasContentWidthPx: 196,
            matchedCanvasContentHeightPx: 180,
            placementOffsetXPx: 2,
            placementOffsetYPx: 0,
            warnings: [],
            warningEvents: [{
                code: 'matched-canvas-content-fitted',
                unit: 'px',
                contentWidth: 196,
                contentHeight: 180,
                innerWidth: 196,
                innerHeight: 180,
                documentCanvasWidth: 200,
                documentCanvasHeight: 180,
            }],
        }));
    });

    const result = await previewOf(createRenderingScenarioOwner(deps), sender(), request);

    // The page arrives whole, with the native sentence.
    expect(decodeScanCleanupPreviewResult(result)).toMatchObject({outputs: [{metadata: {
        outputWidthPx: 252,
        outputHeightPx: 232,
        canvasWidthPx: 200,
        canvasHeightPx: 180,
        matchedCanvasContentWidthPx: 196,
        matchedCanvasContentHeightPx: 180,
        placementOffsetXPx: 2,
        canvasOverflow: true,
        warnings: [formatScanCleanupWarningEvent({
            code: 'matched-canvas-content-fitted',
            unit: 'px',
            contentWidth: 196,
            contentHeight: 180,
            innerWidth: 196,
            innerHeight: 180,
            documentCanvasWidth: 200,
            documentCanvasHeight: 180,
        })],
    }}]});

}

export async function scenarioRejectsAMatchedPageWhoseContentBoxDoesNotFitTheCanvasItNames(): Promise<void> {

    const metadata = {
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        sourceRegion: {
            xPx: 0,
            yPx: 0,
            widthPx: 200,
            heightPx: 180,
        },
        contentBox: null,
        cropRect: {
            xPx: 0,
            yPx: 0,
            widthPx: 252,
            heightPx: 232,
        },
        appliedMargins: {
            leftPx: 0,
            topPx: 0,
            rightPx: 0,
            bottomPx: 0,
        },
        outputWidthPx: 252,
        outputHeightPx: 232,
        canvasWidthPx: 200,
        canvasHeightPx: 180,
        canvasPolicy: 'strict-maximum',
        canvasOverflow: true,
        // The box the page is placed in is wider than the canvas it is
        // placed on, which no producer can mean: the content box is what
        // every consumer lays out from.
        matchedCanvasContentWidthPx: 220,
        matchedCanvasContentHeightPx: 180,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        cutterXPx: null,
        inputWidthPx: 200,
        inputHeightPx: 180,
        rotationDegrees: 0,
        canvasScope: 'page',
        resamplePasses: 1,
        rasterScaleLimited: false,
        warnings: [],
    };

    expect(() => decodeScanCleanupPreviewResult({
        pageNumber: 1,
        totalPages: 1,
        rawImageData: PNG,
        rawWidthPx: 200,
        rawHeightPx: 180,
        pageMetadata: {
            layoutClassification: 'single-uncut-page',
            cutterXPx: null,
            rotationDegrees: 0,
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 1,
        },
        outputs: [{
            imageData: PNG,
            metadata,
        }],
    })).toThrow(/intrinsic\/canvas placement/u);

}

export async function scenarioAnswersTheVisiblePageWhenThePrefetchThatStartedTheMeasurementIsDropped(): Promise<void> {

    const {deps} = await previewDependencies();
    const measuring = Promise.withResolvers<undefined>();
    const releaseMeasurement = Promise.withResolvers<undefined>();
    let measurements = 0;
    // The real reader passes its caller's signal to the native command, so
    // a measurement that carries one dies with that caller.
    deps.getPageSizes = vi.fn(async (_path, options) => {
        measurements += 1;
        measuring.resolve(undefined);
        if (options?.signal) await waitForRelease(releaseMeasurement.promise, options.signal);
        else await releaseMeasurement.promise;
        return DOCUMENT_PAGE_SIZES;
    });
    const canvases = new Map<number, unknown>();
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: Array<{sourcePageIndex: number}>;
        };
        canvases.set(manifest.pages[0]!.sourcePageIndex + 1, manifest.documentCanvas);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();

    const prefetch = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
    await measuring.promise;
    const visible = previewOf(service, owner, {
        ...request,
        visible: true,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
        // The prefetch that started the measurement is retired while the page
        // the user is on is still waiting for it.
    service.cancel(owner, {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        invalidateRawCache: false,
        retainPages: [1],
    });
    releaseMeasurement.resolve(undefined);

    await expect(prefetch).rejects.toMatchObject({name: 'AbortError'});
    await expect(visible).resolves.toMatchObject({pageNumber: 1});
    // And it got the measured canvas, not the empty answer a cancelled
    // measurement would have left behind.
    expect(canvases.get(1)).toEqual(DOCUMENT_CANVAS);
    expect(measurements).toBe(1);

}

export async function scenarioKeepsTheSharedMeasurementAliveWhenALaterAwaiterIsCancelled(): Promise<void> {

    const {deps} = await previewDependencies();
    const measuring = Promise.withResolvers<undefined>();
    const releaseMeasurement = Promise.withResolvers<undefined>();
    let measurements = 0;
    // The real reader passes its caller's signal to the native command, so
    // a measurement that carries one dies with that caller.
    deps.getPageSizes = vi.fn(async (_path, options) => {
        measurements += 1;
        measuring.resolve(undefined);
        if (options?.signal) await waitForRelease(releaseMeasurement.promise, options.signal);
        else await releaseMeasurement.promise;
        return DOCUMENT_PAGE_SIZES;
    });
    const canvases = new Map<number, unknown>();
    const originalSidecar = deps.runSidecar;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            documentCanvas?: unknown;
            pages: Array<{sourcePageIndex: number}>;
        };
        canvases.set(manifest.pages[0]!.sourcePageIndex + 1, manifest.documentCanvas);
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();

    const visible = previewOf(service, owner, {
        ...request,
        visible: true,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
    await measuring.promise;
    const neighbour = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
    service.cancel(owner, {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
        invalidateRawCache: false,
        retainPages: [1],
    });
    releaseMeasurement.resolve(undefined);

    await expect(neighbour).rejects.toMatchObject({name: 'AbortError'});
    await expect(visible).resolves.toMatchObject({pageNumber: 1});
    expect(canvases.get(1)).toEqual(DOCUMENT_CANVAS);
    expect(measurements).toBe(1);

}

export async function scenarioPublishesAReRenderedRasterOverADestinationAnotherRequestStillHolds(): Promise<void> {

    const {deps} = await previewDependencies();
    const published: Array<[string, string]> = [];
    deps.publishRaster = vi.fn(async (source: string, destination: string, options) => {
        published.push([
            source,
            destination,
        ]);
        await atomicReplace(source, destination, options);
    });
    const service = createRenderingScenarioOwner(deps);
    const owner = sender();

    await previewOf(service, owner, request);
    service.cancel(owner, {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    });
    await previewOf(service, owner, request);

    // Every publication is a replace of the page's stable path rather than
    // a raw rename, so a destination another request has open is moved
    // aside instead of failing the write on Windows.
    expect(published.length).toBeGreaterThanOrEqual(2);
    expect(published.every(([
        source,
        destination,
    ]) => source.includes('.part.png') && !destination.includes('.part.'))).toBe(true);
    expect(vi.mocked(deps.publishRaster).mock.calls.every(call => call[2]?.durable === false)).toBe(true);

}
describe('scanCleanupPreviewRenderingTest', () => {
    it('uses the rendering owner boundary for job disposal', async () => {
        const retention = scanCleanupRasterRetention(defaultDependencies);
        const owner = scanCleanupPreviewRenderingOwner(defaultDependencies, retention);
        expect(owner).toHaveProperty('preview');
        await expect(owner.dispose()).resolves.toBeUndefined();
        await retention.dispose();
    });
    const scenarios = [
        [
            'return real sidecar bytes and metadata',
            scenarioReturnsRealSidecarBytesAndValidatedMetadata,
        ],
        [
            'avoid upscaling a proven 72-DPI document',
            scenarioDoesNotUpscaleAProven72DPIRasterDocumentForItsBasePreview,
        ],
        [
            'bound an oversized raster before Poppler',
            scenarioBoundsAPhysicallyOversizedScanPreviewBeforePopplerRasterizesIt,
        ],
        [
            'stream display raster and clean source-grid text',
            scenarioStreamsTheDisplayRasterButCleansBinaryPreviewTextOnTheSourceGrid,
        ],
        [
            'render a bounded detail region',
            scenarioRendersOnlyTheRequestedZoomRegionAtTrueOutputDPIWithinTheTileBudget,
        ],
        [
            'handoff detail through shared raster retention',
            scenarioHandsTheDetailTileToTheSidecarThroughTheSharedRasterHandoff,
        ],
        [
            'retain recent base analysis while pruning stale entries',
            scenarioKeepsARecentlyReadBaseAnalysisWhilePruningAStaleEntry,
        ],
        [
            'probe only the requested page first',
            scenarioProbesOnlyTheRequestedPageForTheFirstPreviewRasterStructure,
        ],
        [
            'keep intrinsic canvases without geometry',
            scenarioKeepsIntrinsicPageCanvasesWhenTheDocumentGeometryCannotBeRead,
        ],
        [
            'present classified spreads on half-sheet canvas',
            scenarioPresentsAClassifiedSpreadOnAHalfSheetCanvasWithoutForcingAnUnmeasuredCut,
        ],
        [
            'reuse detected output mode',
            scenarioReusesTheDetectedOutputModeForAnAutomaticPreview,
        ],
        [
            'stop canceled trusted extraction',
            scenarioDoesNotTurnACanceledTrustedLayerExtractionIntoARasterFallback,
        ],
        [
            'reuse base geometry for detail',
            scenarioReusesBaseGeometryForDetailAfterDetectionResolvesAuto,
        ],
        [
            'render matched lossless page with fallback',
            scenarioRendersAMatchedLosslessPageTheFinalRunCannotKeepLossless,
        ],
        [
            'keep matched lossless page lossless',
            scenarioKeepsAMatchedLosslessPageLosslessWhenTheDocumentSharesOneGrid,
        ],
        [
            'use analysis-only lossless metadata',
            scenarioUsesAnalysisOnlyOutputMetadataForTheLosslessOriginalPagePreview,
        ],
        [
            'fit lossless spread pair-wide',
            scenarioUsesThePairWideLosslessFitWhenOneSpreadLeafReachesTheMarginBox,
        ],
        [
            'reserve exact matched margins',
            scenarioReservesExactFinalCanvasMarginsInAMatchedLosslessPreviewAndSaysWhenContentIsFitted,
        ],
        [
            'sample the carried output grid',
            scenarioSamplesTheMatchedPreviewCanvasOnTheGridTheOutputPageCarries,
        ],
        [
            'name paper outside the canvas',
            scenarioNamesPaperTheMatchedPreviewCanvasCannotHold,
        ],
        [
            'match provisional known-page previews',
            scenarioMatchesProvisionalPreviewsFromKnownPagesWithoutGuessingUnknownLayouts,
        ],
        [
            'keep separate crops without matching',
            scenarioLeavesEveryPageItsOwnCropWhenPageSizesAreNotMatched,
        ],
        [
            'retry measurement after fallback',
            scenarioPreviewsWithoutMatchingWhenItCannotMeasureAndMeasuresAgainNextTime,
        ],
        [
            'measure under the document owner',
            scenarioMeasuresUnderTheDocumentRatherThanUnderTheRequestThatAskedFirst,
        ],
        [
            'carry engine fit across the bridge',
            scenarioCarriesAPageTheEngineFittedBelowTheDocumentScaleAcrossTheBridge,
        ],
        [
            'reject content outside its named canvas',
            scenarioRejectsAMatchedPageWhoseContentBoxDoesNotFitTheCanvasItNames,
        ],
        [
            'answer visible page after prefetch drop',
            scenarioAnswersTheVisiblePageWhenThePrefetchThatStartedTheMeasurementIsDropped,
        ],
        [
            'keep shared measurement for another awaiter',
            scenarioKeepsTheSharedMeasurementAliveWhenALaterAwaiterIsCancelled,
        ],
        [
            'publish over a held destination safely',
            scenarioPublishesAReRenderedRasterOverADestinationAnotherRequestStillHolds,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
