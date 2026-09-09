import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupNormalizedRect,
    IScanCleanupPixelPoint,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/electronApiScanCleanup';
import { decodeNativeScanCleanupPreviewOutputMetadataJson } from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type { INativeScanCleanupReusableGeometryV3 } from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    getScanCleanupPageOverride,
    resolveScanCleanupMarginsMm,
} from '@contracts/scanCleanupPageOverrides';
import { PREVIEW_DPI } from '@evb/scan-cleanup/core/detection';
import {
    logRasterHandoff,
    resolveRasterHandoff,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {
    readScanCleanupPngDimensions as readPngDimensions,
    renderScanCleanupRasterToDisk as renderRasterToDisk,
} from '@evb/scan-cleanup/core/rasterValidation';
import { getErrorMessage } from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';
import { buildRunnableNativeScanCleanupManifest } from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {
    SCAN_CLEANUP_MAX_DIMENSION_PX,
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupRequestedRenderDpi,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import type {
    IRawPreview,
    INativePreviewOutputMetadata,
    IBasePreviewAnalysis,
    IScanCleanupRenderingDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    DETAIL_TILE_MAX_PIXELS,
    DEFAULT_SOURCE_DPI,
    PREVIEW_MAX_IMAGE_BYTES,
    BASE_ANALYSIS_CACHE_PAGE_LIMIT,
    BASE_ANALYSIS_CACHE_BYTE_LIMIT,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
const logger = createLogger('scan-cleanup-preview-pipeline');
export function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}
export async function persistBaseAnalysisArtifacts(
    outputs: IBasePreviewAnalysis['outputs'],
    canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>>,
    signal: AbortSignal,
    dependencies: IScanCleanupRenderingDependencies,
) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup pipeline requires injected filesystem capabilities');
    if (!dependencies.readFile) throw new Error('Scan cleanup pipeline requires injected readFile capability');
    const analysisDirectory = join(
        dependencies.getTempDir(),
        `scan-cleanup-rasters-${randomUUID()}-${process.pid}`,
    );
    await fileSystem.mkdir(analysisDirectory, {recursive: true});
    const canonicalRasterPaths: IBasePreviewAnalysis['canonicalRasterPaths'] = {};
    const baseMetadataPaths: IBasePreviewAnalysis['baseMetadataPaths'] = {};
    try {
        for (const half of [
            'full',
            'left',
            'right',
        ] as const) {
            const raster = canonicalRasters[half];
            const metadata = outputs[half];
            if (!raster || !metadata) continue;
            signal.throwIfAborted();
            const rasterPath = join(analysisDirectory, `base-cleaned-${half}.png`);
            const metadataPath = join(analysisDirectory, `base-metadata-${half}.json`);
            await fileSystem.writeFile(rasterPath, raster);
            await fileSystem.writeFile(metadataPath, JSON.stringify(metadata));
            canonicalRasterPaths[half] = rasterPath;
            baseMetadataPaths[half] = metadataPath;
        }
        signal.throwIfAborted();
        return {
            analysisDirectory,
            canonicalRasterPaths,
            baseMetadataPaths,
        };
    } catch (error) {
        await fileSystem.rm(analysisDirectory, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}
export function removeBaseAnalysisArtifacts(analysis: IBasePreviewAnalysis, dependencies: IScanCleanupRenderingDependencies) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) {
        return Promise.reject(new Error('Scan cleanup pipeline requires injected filesystem capabilities'));
    }
    return fileSystem.rm(analysis.analysisDirectory, {
        recursive: true,
        force: true,
    }).catch(error => {
        logger.warn(`Failed to drop scan cleanup base analysis artifacts: ${getErrorMessage(error)}`);
    });
}
export async function pruneBaseAnalysisCache(
    cache: Map<string, IBasePreviewAnalysis>,
    pinnedKeys: ReadonlySet<string> = new Set(),
    dependencies: IScanCleanupRenderingDependencies,
) {
    let retainedBytes = [...cache.values()]
        .reduce((total, analysis) => total + analysis.canonicalRasterBytes, 0);
    while (
        cache.size > BASE_ANALYSIS_CACHE_PAGE_LIMIT
        || retainedBytes > BASE_ANALYSIS_CACHE_BYTE_LIMIT
    ) {
        const oldest = [...cache.entries()].find(([key]) => !pinnedKeys.has(key));
        if (!oldest) {
            return;
        }
        cache.delete(oldest[0]);
        await removeBaseAnalysisArtifacts(oldest[1], dependencies);
        retainedBytes -= oldest[1].canonicalRasterBytes;
    }
}
export function resolveFallbackDetailDpi(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    raw: Pick<IRawPreview, 'width' | 'height' | 'dpi'>,
    sourceDpi: number,
    sourceRasterDetected: boolean,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const swapsAxes = pageOverride.rotationDegrees === 90 || pageOverride.rotationDegrees === 270;
    const margins = resolveScanCleanupMarginsMm(request.options.marginsMm, pageOverride);
    const widthAtPreviewDpi = (swapsAxes ? raw.height : raw.width)
        + (margins.leftMm + margins.rightMm) / 25.4 * raw.dpi;
    const heightAtPreviewDpi = (swapsAxes ? raw.width : raw.height)
        + (margins.topMm + margins.bottomMm) / 25.4 * raw.dpi;
    const canvasWidth = request.options.matchPageSize && documentCanvas ? documentCanvas.widthPx : 0;
    const canvasHeight = request.options.matchPageSize && documentCanvas ? documentCanvas.heightPx : 0;
    const budgetDpi = raw.dpi * Math.sqrt(
        DETAIL_TILE_MAX_PIXELS * 0.98
        / (Math.max(1, widthAtPreviewDpi, canvasWidth)
            * Math.max(1, heightAtPreviewDpi, canvasHeight)),
    );
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi: Math.max(sourceDpi, raw.dpi),
        outputCarriesBinaryLayer:
            request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed',
        sourceRasterDetected,
    });
    return {
        renderDpi: Math.max(1, Math.floor(Math.min(requestedRenderDpi, budgetDpi))),
        requestedRenderDpi,
    };
}
function applyPreviewAffine(
    affine: NonNullable<IScanCleanupPreviewMetadata['forwardTransform']>,
    point: IScanCleanupPixelPoint,
) {
    return {
        x: affine.matrix[0]![0]! * point.x
            + affine.matrix[0]![1]! * point.y
            + affine.matrix[0]![2]!,
        y: affine.matrix[1]![0]! * point.x
            + affine.matrix[1]![1]! * point.y
            + affine.matrix[1]![2]!,
    };
}
function interpolateDewarpOutputToSource(
    mapping: NonNullable<INativeScanCleanupReusableGeometryV3['dewarpMapping']>,
    point: IScanCleanupPixelPoint,
) {
    if (
        mapping.columns < 2
        || mapping.rows < 2
        || mapping.outputWidth <= 0
        || mapping.outputHeight <= 0
        || mapping.outputToSource.length !== mapping.columns * mapping.rows
    ) {
        throw new Error('Scan cleanup base preview has an invalid dewarp mapping');
    }
    const gridX = Math.max(0, Math.min(
        mapping.columns - 1,
        point.x / mapping.outputWidth * (mapping.columns - 1),
    ));
    const gridY = Math.max(0, Math.min(
        mapping.rows - 1,
        point.y / mapping.outputHeight * (mapping.rows - 1),
    ));
    const left = Math.floor(gridX);
    const top = Math.floor(gridY);
    const right = Math.min(mapping.columns - 1, left + 1);
    const bottom = Math.min(mapping.rows - 1, top + 1);
    const tx = gridX - left;
    const ty = gridY - top;
    const at = (column: number, row: number) => mapping.outputToSource[row * mapping.columns + column]!;
    const topLeft = at(left, top);
    const topRight = at(right, top);
    const bottomLeft = at(left, bottom);
    const bottomRight = at(right, bottom);
    return {
        x: (topLeft.x * (1 - tx) + topRight.x * tx) * (1 - ty)
            + (bottomLeft.x * (1 - tx) + bottomRight.x * tx) * ty,
        y: (topLeft.y * (1 - tx) + topRight.y * tx) * (1 - ty)
            + (bottomLeft.y * (1 - tx) + bottomRight.y * tx) * ty,
    };
}
function inverseRotatePreviewPoint(
    point: IScanCleanupPixelPoint,
    metadata: Pick<
        IScanCleanupPreviewMetadata,
        'inputWidthPx' | 'inputHeightPx' | 'rotationDegrees'
    >,
) {
    switch (metadata.rotationDegrees) {
        case 0:
            return point;
        case 90:
            return {
                x: point.y,
                y: metadata.inputHeightPx - point.x,
            };
        case 180:
            return {
                x: metadata.inputWidthPx - point.x,
                y: metadata.inputHeightPx - point.y,
            };
        case 270:
            return {
                x: metadata.inputWidthPx - point.y,
                y: point.x,
            };
    }
}
function mapBaseOutputToRawSource(
    metadata: INativePreviewOutputMetadata,
    point: IScanCleanupPixelPoint,
) {
    const rotated = metadata.inverseTransform
        ? applyPreviewAffine(metadata.inverseTransform, point)
        : metadata.dewarpMapping
            ? interpolateDewarpOutputToSource(metadata.dewarpMapping, point)
            : null;
    if (!rotated) {
        throw new Error('Scan cleanup base preview has no reusable detail geometry');
    }
    return inverseRotatePreviewPoint(rotated, metadata);
}
function resolveDetailRenderDpi(
    viewports: NonNullable<IScanCleanupPreviewRequest['detail']>['viewports'],
    outputs: IBasePreviewAnalysis['outputs'],
    requestedRenderDpi: number,
    baseDpi = PREVIEW_DPI,
) {
    let renderDpi = requestedRenderDpi;
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = viewports[half];
        const metadata = outputs[half];
        if (!viewport || !metadata) continue;
        const visiblePixelsAtPreviewDpi = Math.max(
            1,
            metadata.outputWidthPx
                * metadata.outputHeightPx
                * viewport.widthNormalized
                * viewport.heightNormalized,
        );
        const budgetDpi = baseDpi * Math.sqrt(
            DETAIL_TILE_MAX_PIXELS * 0.98 / visiblePixelsAtPreviewDpi,
        );
        renderDpi = Math.min(renderDpi, budgetDpi);
    }
    return Math.max(1, Math.floor(renderDpi));
}
function resolveDetailViewport(
    viewport: IScanCleanupNormalizedRect,
    metadata: INativePreviewOutputMetadata,
    renderScale: number,
) {
    const targetWidth = metadata.outputWidthPx * renderScale;
    const targetHeight = metadata.outputHeightPx * renderScale;
    const left = Math.max(0, Math.floor(viewport.xNormalized * targetWidth));
    const top = Math.max(0, Math.floor(viewport.yNormalized * targetHeight));
    const right = Math.min(
        Math.round(targetWidth),
        Math.ceil((viewport.xNormalized + viewport.widthNormalized) * targetWidth),
    );
    const bottom = Math.min(
        Math.round(targetHeight),
        Math.ceil((viewport.yNormalized + viewport.heightNormalized) * targetHeight),
    );
    return {
        xPx: left,
        yPx: top,
        widthPx: Math.max(1, right - left),
        heightPx: Math.max(1, bottom - top),
    };
}
function resolveDetailSourceCrop(
    metadata: INativePreviewOutputMetadata,
    sampledRegion: IScanCleanupPreviewMetadata['sourceRegion'],
    renderScale: number,
    fullWidth: number,
    fullHeight: number,
) {
    const baseLeft = sampledRegion.xPx / renderScale;
    const baseTop = sampledRegion.yPx / renderScale;
    const baseRight = (sampledRegion.xPx + sampledRegion.widthPx) / renderScale;
    const baseBottom = (sampledRegion.yPx + sampledRegion.heightPx) / renderScale;
    const xSamples = [
        baseLeft,
        baseRight,
    ];
    const ySamples = [
        baseTop,
        baseBottom,
    ];
    const mapping = metadata.inverseTransform ? null : metadata.dewarpMapping;
    if (mapping) {
        for (let column = 1; column < mapping.columns - 1; column += 1) {
            const x = mapping.outputWidth * column / (mapping.columns - 1);
            if (x > baseLeft && x < baseRight) xSamples.push(x);
        }
        for (let row = 1; row < mapping.rows - 1; row += 1) {
            const y = mapping.outputHeight * row / (mapping.rows - 1);
            if (y > baseTop && y < baseBottom) ySamples.push(y);
        }
    }
    const points = xSamples.flatMap(x => ySamples.map(y => mapBaseOutputToRawSource(metadata, {
        x,
        y,
    })));
    const padding = 24;
    const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) * renderScale) - padding);
    const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) * renderScale) - padding);
    const right = Math.min(
        fullWidth,
        Math.ceil(Math.max(...points.map(point => point.x)) * renderScale) + padding,
    );
    const bottom = Math.min(
        fullHeight,
        Math.ceil(Math.max(...points.map(point => point.y)) * renderScale) + padding,
    );
    if (right <= left || bottom <= top) {
        throw new Error('Scan cleanup detail geometry resolved outside the source page');
    }
    return {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
}
export async function readPreviewBytes(path: string, dependencies: IScanCleanupRenderingDependencies) {
    if (!dependencies.stat || !dependencies.readFile) {
        throw new Error('Scan cleanup preview pipeline requires injected stat and readFile capabilities');
    }
    const file = await dependencies.stat(path);
    if (file.size < 1 || file.size > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`Scan cleanup preview image exceeds ${PREVIEW_MAX_IMAGE_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await dependencies.readFile(path));
    readPngDimensions(bytes, undefined, 'preview');
    return bytes;
}
export async function runDetailPreview(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    signal: AbortSignal,
    baseRaw: IRawPreview,
    baseRasterPath: string,
    analysis: IBasePreviewAnalysis,
    sourceDpiCandidate: number | null | undefined,
    sourceRasterDetected: boolean,
    scratch: string,
    dependencies: IScanCleanupRenderingDependencies,
): Promise<TScanCleanupPreviewWireResult> {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup pipeline requires injected filesystem capabilities');
    const getAvailableScratchBytes = dependencies.getAvailableScratchBytes;
    if (!getAvailableScratchBytes) throw new Error('Scan cleanup pipeline requires injected scratch-budget capability');
    if (!dependencies.readFile) throw new Error('Scan cleanup pipeline requires injected readFile capability');
    const sourceDpiDetected = sourceDpiCandidate !== null
        && sourceDpiCandidate !== undefined
        && Number.isFinite(sourceDpiCandidate)
        && sourceDpiCandidate > 0;
    const sourceDpi = sourceDpiDetected ? Number(sourceDpiCandidate) : DEFAULT_SOURCE_DPI;
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi: Math.max(sourceDpi, analysis.baseRenderDpi),
        outputCarriesBinaryLayer: request.detail.outputMode === 'bw',
        sourceRasterDetected,
    });
    const renderDpi = resolveDetailRenderDpi(
        request.detail.viewports,
        analysis.outputs,
        requestedRenderDpi,
        analysis.baseRenderDpi,
    );
    if (renderDpi <= analysis.baseRenderDpi) {
        return {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: analysis.pageMetadata,
            outputs: [],
        };
    }
    const renderScale = renderDpi / analysis.baseRenderDpi;
    const rawRenderScale = renderDpi / baseRaw.dpi;
    const fullSourceWidth = Math.max(1, Math.round(baseRaw.width * rawRenderScale));
    const fullSourceHeight = Math.max(1, Math.round(baseRaw.height * rawRenderScale));
    const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(request.detail.outputMode);
    const binary = dependencies.resolveBinary();
    if (!binary) throw new Error('Scan cleanup native tool is unavailable');
    const pageOverride = getScanCleanupPageOverride(request.options.pageOverrides, request.pageNumber);
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const pageInputs = [];
    const outputFiles: Array<{
        outputPath: string;
        metadataPath: string;
    }> = [];
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = request.detail.viewports[half];
        const baseMetadata = analysis.outputs[half];
        if (!viewport || !baseMetadata) continue;
        if (viewport.rotationDegrees !== pageOverride.rotationDegrees) {
            throw new Error('Scan cleanup detail viewport rotation is stale');
        }
        const renderRegion = resolveDetailViewport(
            viewport,
            baseMetadata,
            renderScale,
        );
        const outputWidth = Math.max(1, Math.round(baseMetadata.outputWidthPx * renderScale));
        const outputHeight = Math.max(1, Math.round(baseMetadata.outputHeightPx * renderScale));
        const processingApron = request.detail.outputMode === 'bw' || request.detail.outputMode === 'mixed'
            ? 256
            : 8;
        const sampledRegion = {
            xPx: Math.max(0, renderRegion.xPx - processingApron),
            yPx: Math.max(0, renderRegion.yPx - processingApron),
            widthPx: 0,
            heightPx: 0,
        };
        const sampledRight = Math.min(
            outputWidth,
            renderRegion.xPx + renderRegion.widthPx + processingApron,
        );
        const sampledBottom = Math.min(
            outputHeight,
            renderRegion.yPx + renderRegion.heightPx + processingApron,
        );
        sampledRegion.widthPx = sampledRight - sampledRegion.xPx;
        sampledRegion.heightPx = sampledBottom - sampledRegion.yPx;
        const sourceCrop = resolveDetailSourceCrop(
            baseMetadata,
            sampledRegion,
            renderScale,
            fullSourceWidth,
            fullSourceHeight,
        );
        if (
            sourceCrop.width > 40_000
            || sourceCrop.height > 40_000
            || sourceCrop.width * sourceCrop.height > maxSourcePixels
        ) {
            throw new Error(
                `Scan cleanup detail source crop ${sourceCrop.width}x${sourceCrop.height} exceeds native limits`,
            );
        }
        const handoff = await resolveRasterHandoff([{
            renderDpi,
            raster: {
                dpi: renderDpi,
                width: sourceCrop.width,
                height: sourceCrop.height,
            },
        }], scratch, getAvailableScratchBytes);
        logRasterHandoff(logScanCleanupMessage, 'detail tile', handoff);
        const inputPath = join(scratch, `detail-source-${half}.${handoff.format}`);
        const renderedSource = await renderRasterToDisk(
            request.sourcePdfPath,
            request.pageNumber,
            inputPath,
            signal,
            {
                ...dependencies,
                fileSystem: {open: fileSystem.open},
            },
            logScanCleanupMessage,
            renderDpi,
            maxSourcePixels,
            sourceCrop,
            handoff.format,
            {
                expectedWidthPx: sourceCrop.width,
                expectedHeightPx: sourceCrop.height,
                maxPixels: maxSourcePixels,
                maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
            },
            'raster',
            'preview',
        );
        sourceCrop.width = renderedSource.width;
        sourceCrop.height = renderedSource.height;
        const baseMetadataPath = analysis.baseMetadataPaths[half];
        const baseCleanedRasterPath = analysis.canonicalRasterPaths[half];
        if (!baseMetadataPath || !baseCleanedRasterPath) {
            throw new Error(`Scan cleanup detail has no canonical ${half} base raster`);
        }
        const output = {
            outputPath: join(scratch, `detail-clean-${half}.png`),
            metadataPath: join(scratch, `detail-clean-${half}.json`),
        };
        outputFiles.push(output);
        pageInputs.push({
            inputPath,
            pageNumber: request.pageNumber,
            dpi: renderDpi,
            sourceDpi,
            requestedRenderDpi,
            resolvedOutputMode: request.detail.outputMode,
            pageMetadataPath: join(scratch, `detail-page-${half}.json`),
            outputs: [output],
            detailRenderPlan: {
                baseMetadataPath,
                baseRasterPath,
                baseCleanedRasterPath,
                sourceCrop: {
                    xPx: sourceCrop.x,
                    yPx: sourceCrop.y,
                    widthPx: sourceCrop.width,
                    heightPx: sourceCrop.height,
                },
                fullSourceWidthPx: fullSourceWidth,
                fullSourceHeightPx: fullSourceHeight,
                scale: renderScale,
                renderRegion,
                sampledRegion,
            },
        });
    }
    if (pageInputs.length === 0) {
        throw new Error('Scan cleanup detail request has no matching base output');
    }
    const manifest = buildRunnableNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: effectiveOptions,
        experimental: {autoDewarp: false},
        pages: pageInputs,
        allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir(),
    });
    const manifestPath = join(scratch, 'detail-manifest.json');
    await fileSystem.writeFile(manifestPath, JSON.stringify(manifest));
    await dependencies.runSidecar(
        binary,
        manifestPath,
        signal,
        logScanCleanupMessage,
        () => undefined,
        {allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir()},
    );
    const cleaned = [] as IScanCleanupPreviewResult['outputs'];
    for (const output of outputFiles) {
        const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(
            String(await dependencies.readFile(output.metadataPath, 'utf8')),
        );
        cleaned.push({
            imageData: await readPreviewBytes(output.outputPath, dependencies),
            metadata: {
                ...nativeMetadata,
                ...(nativeMetadata.dewarpModel === undefined
                    ? {}
                    : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
            },
        });
    }
    return {
        pageNumber: request.pageNumber,
        totalPages: baseRaw.totalPages,
        rawWidthPx: baseRaw.width,
        rawHeightPx: baseRaw.height,
        pageMetadata: analysis.pageMetadata,
        outputs: cleaned,
    };
}
