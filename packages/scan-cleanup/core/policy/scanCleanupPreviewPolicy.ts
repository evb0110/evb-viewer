import type {
    IScanCleanupDocumentCanvasPlan,
    IScanCleanupNormalizedRect,
    IScanCleanupPixelPoint,
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    TNativeScanCleanupPreviewOutputArtifactMetadataV3,
    TNativeScanCleanupPreviewPageArtifactMetadataV3,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import type {
    INativeScanCleanupReusableGeometryV3,
    TScanCleanupWarningEvent,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {resolveScanCleanupMarginsMm} from '@evb/scan-cleanup/core/policy/scanCleanupPagePolicy';
import {
    resolveScanCleanupPipelineMaxPixels,
    resolveScanCleanupRequestedRenderDpi,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import {
    describeScanCleanupNativeWarnings,
    formatScanCleanupWarningEvent,
} from '@evb/scan-cleanup/core/policy/scanCleanupWarningEvents';
import {PREVIEW_DPI} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';

/*
 * What a preview renders and how its native metadata becomes the preview
 * result. Desktop runs the decisions through manifest files and the CLI, the
 * browser through the cleanup engine's WebAssembly build; both read them here.
 */

/** A detail tile's pixel budget, apron included. */
export const DETAIL_TILE_MAX_PIXELS = 4_000_000;
/** The source resolution assumed for a page whose scan resolution is unknown. */
export const DEFAULT_SOURCE_DPI = 300;

/** A rendered page raster's size and resolution. */
export interface IScanCleanupPreviewRasterSize {
    width: number;
    height: number;
    dpi: number;
}

/** A base preview's native output metadata, by output half. */
export type TScanCleanupPreviewBaseOutputs = Partial<Record<
    IScanCleanupPreviewMetadata['half'],
    TNativeScanCleanupPreviewOutputArtifactMetadataV3
>>;

export function resolveFallbackDetailDpi(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    raw: IScanCleanupPreviewRasterSize,
    sourceDpi: number,
    sourceRasterDetected: boolean,
    documentCanvas: IScanCleanupDocumentCanvasPlan | null,
) {
    const pageOverride = getScanCleanupPageOverride(
        request.options.pageOverrides,
        request.pageNumber,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
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
    metadata: TNativeScanCleanupPreviewOutputArtifactMetadataV3,
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
    outputs: TScanCleanupPreviewBaseOutputs,
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
    metadata: TNativeScanCleanupPreviewOutputArtifactMetadataV3,
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
    metadata: TNativeScanCleanupPreviewOutputArtifactMetadataV3,
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

/** One output half of a detail render: the tile to clean and where it sits. */
export interface IScanCleanupDetailHalfPlan {
    half: IScanCleanupPreviewMetadata['half'];
    renderRegion: {
        xPx: number;
        yPx: number;
        widthPx: number;
        heightPx: number;
    };
    sampledRegion: {
        xPx: number;
        yPx: number;
        widthPx: number;
        heightPx: number;
    };
    /** The source pixels to render at `renderDpi`, in the full source raster. */
    sourceCrop: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

export type TScanCleanupDetailPreviewPlan =
    | {kind: 'base-suffices'}
    | {
        kind: 'render';
        renderDpi: number;
        requestedRenderDpi: number;
        sourceDpi: number;
        renderScale: number;
        fullSourceWidthPx: number;
        fullSourceHeightPx: number;
        maxSourcePixels: number;
        halves: IScanCleanupDetailHalfPlan[];
    };

/**
 * The detail render a viewport over a base preview asks for: the resolution
 * it refines to and, per output half, the source tile with its processing
 * apron. A viewport the base already shows at full resolution needs none.
 */
export function planScanCleanupDetailPreview(input: {
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>};
    baseRaw: IScanCleanupPreviewRasterSize;
    baseOutputs: TScanCleanupPreviewBaseOutputs;
    baseRenderDpi: number;
    sourceDpiCandidate: number | null | undefined;
    sourceRasterDetected: boolean;
    rasterMaxPixels?: number;
}): TScanCleanupDetailPreviewPlan {
    const {
        request, baseRaw,
    } = input;
    const sourceDpiDetected = input.sourceDpiCandidate !== null
        && input.sourceDpiCandidate !== undefined
        && Number.isFinite(input.sourceDpiCandidate)
        && input.sourceDpiCandidate > 0;
    const sourceDpi = sourceDpiDetected ? Number(input.sourceDpiCandidate) : DEFAULT_SOURCE_DPI;
    const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
        sourceDpi: Math.max(sourceDpi, input.baseRenderDpi),
        outputCarriesBinaryLayer: request.detail.outputMode === 'bw',
        sourceRasterDetected: input.sourceRasterDetected,
    });
    const renderDpi = resolveDetailRenderDpi(
        request.detail.viewports,
        input.baseOutputs,
        requestedRenderDpi,
        input.baseRenderDpi,
    );
    if (renderDpi <= input.baseRenderDpi) {
        return {kind: 'base-suffices'};
    }
    const renderScale = renderDpi / input.baseRenderDpi;
    const rawRenderScale = renderDpi / baseRaw.dpi;
    const fullSourceWidthPx = Math.max(1, Math.round(baseRaw.width * rawRenderScale));
    const fullSourceHeightPx = Math.max(1, Math.round(baseRaw.height * rawRenderScale));
    const maxSourcePixels = resolveScanCleanupPipelineMaxPixels(
        request.detail.outputMode,
        input.rasterMaxPixels,
    );
    const pageOverride = getScanCleanupPageOverride(
        request.options.pageOverrides,
        request.pageNumber,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    const halves: IScanCleanupDetailHalfPlan[] = [];
    for (const half of [
        'full',
        'left',
        'right',
    ] as const) {
        const viewport = request.detail.viewports[half];
        const baseMetadata = input.baseOutputs[half];
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
        const sampledLeft = Math.max(0, renderRegion.xPx - processingApron);
        const sampledTop = Math.max(0, renderRegion.yPx - processingApron);
        const sampledRegion = {
            xPx: sampledLeft,
            yPx: sampledTop,
            widthPx: Math.min(outputWidth, renderRegion.xPx + renderRegion.widthPx + processingApron) - sampledLeft,
            heightPx: Math.min(outputHeight, renderRegion.yPx + renderRegion.heightPx + processingApron) - sampledTop,
        };
        const sourceCrop = resolveDetailSourceCrop(
            baseMetadata,
            sampledRegion,
            renderScale,
            fullSourceWidthPx,
            fullSourceHeightPx,
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
        halves.push({
            half,
            renderRegion,
            sampledRegion,
            sourceCrop,
        });
    }
    if (halves.length === 0) {
        throw new Error('Scan cleanup detail request has no matching base output');
    }
    return {
        kind: 'render',
        renderDpi,
        requestedRenderDpi,
        sourceDpi,
        renderScale,
        fullSourceWidthPx,
        fullSourceHeightPx,
        maxSourcePixels,
        halves,
    };
}

/** A base preview output's metadata as the preview result carries it. */
export function projectScanCleanupPreviewOutputMetadata(
    nativeMetadata: TNativeScanCleanupPreviewOutputArtifactMetadataV3,
    previewWarningEvents: readonly TScanCleanupWarningEvent[],
): IScanCleanupPreviewResult['outputs'][number]['metadata'] {
    return {
        ...nativeMetadata,
        matchedCanvasOpticalContentLeftPx: nativeMetadata.matchedCanvasOpticalContentLeftPx ?? null,
        matchedCanvasOpticalContentRightPx: nativeMetadata.matchedCanvasOpticalContentRightPx ?? null,
        ...(nativeMetadata.dewarpModel === undefined
            ? {}
            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
        ...(nativeMetadata.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: {
                ...nativeMetadata.textToneDiagnostics,
                inkAnchor: nativeMetadata.textToneDiagnostics.inkAnchor ?? null,
                blackPoint: nativeMetadata.textToneDiagnostics.blackPoint ?? null,
                slope: nativeMetadata.textToneDiagnostics.slope ?? null,
            }}),
        warnings: [
            ...[
                ...previewWarningEvents,
                ...nativeMetadata.warningEvents ?? [],
            ].map(event => formatScanCleanupWarningEvent(event)),
            ...describeScanCleanupNativeWarnings({warnings: nativeMetadata.warnings}),
        ],
    } as IScanCleanupPreviewResult['outputs'][number]['metadata'];
}

/** A detail output's metadata: the native record, with the dewarp verdict it implies. */
export function projectScanCleanupDetailOutputMetadata(
    nativeMetadata: TNativeScanCleanupPreviewOutputArtifactMetadataV3,
): IScanCleanupPreviewResult['outputs'][number]['metadata'] {
    return {
        ...nativeMetadata,
        ...(nativeMetadata.dewarpModel === undefined
            ? {}
            : {dewarpApplied: nativeMetadata.dewarpModel !== null}),
    } as IScanCleanupPreviewResult['outputs'][number]['metadata'];
}

/** A base preview's page metadata, with the diagnostics its first output carries. */
export function projectScanCleanupPreviewPageMetadata(
    pageMetadata: TNativeScanCleanupPreviewPageArtifactMetadataV3,
    outputs: IScanCleanupPreviewResult['outputs'],
    autoDewarpAttempted: boolean,
): IScanCleanupPreviewResult['pageMetadata'] {
    const diagnosticMetadata = outputs[0]?.metadata;
    return {
        ...pageMetadata,
        ...(diagnosticMetadata?.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: diagnosticMetadata.detectedSkewDegrees}),
        ...(diagnosticMetadata?.skewConfidence === undefined
            ? {}
            : {skewConfidence: diagnosticMetadata.skewConfidence}),
        ...(diagnosticMetadata?.manualSkew === undefined
            ? {}
            : {manualSkew: diagnosticMetadata.manualSkew}),
        ...(diagnosticMetadata?.binarizationMode === undefined
            ? {}
            : {binarizationMode: diagnosticMetadata.binarizationMode}),
        ...(diagnosticMetadata?.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: diagnosticMetadata.binarizationDiagnostics}),
        ...(diagnosticMetadata?.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: diagnosticMetadata.textToneDiagnostics}),
        ...(diagnosticMetadata?.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: diagnosticMetadata.despeckleFallback}),
        ...(diagnosticMetadata?.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: diagnosticMetadata.dewarpConfidence}),
        ...(diagnosticMetadata?.dewarpApplied === undefined
            ? {}
            : {dewarpApplied: diagnosticMetadata.dewarpApplied}),
        outputDiagnostics: outputs.map(output => ({
            half: output.metadata.half,
            ...(output.metadata.contentDiagnostics === undefined
                ? {}
                : {contentDiagnostics: output.metadata.contentDiagnostics}),
            ...(output.metadata.textToneDiagnostics === undefined
                ? {}
                : {textToneDiagnostics: output.metadata.textToneDiagnostics}),
        })),
        autoDewarpAttempted,
    } as IScanCleanupPreviewResult['pageMetadata'];
}

/**
 * A preserve-quality preview: the page analyzed in place, each output shown
 * as the original raster under the placement lossless assembly writes.
 */
export function projectScanCleanupLosslessPreview(input: {
    pageNumber: IScanCleanupPreviewRequest['pageNumber'];
    totalPages: number;
    raw: {
        width: number;
        height: number;
        bytes: Uint8Array;
    };
    pageMetadata: TNativeScanCleanupPreviewPageArtifactMetadataV3;
    previewWarningEvents: readonly TScanCleanupWarningEvent[];
    matchedCanvas: IScanCleanupDocumentCanvasPlan | undefined;
    sourceDpi: number;
    renderDpi: number;
    requestedRenderDpi: number;
}): TScanCleanupPreviewWireResult {
    const {
        pageMetadata, previewWarningEvents, matchedCanvas, sourceDpi, renderDpi, requestedRenderDpi,
    } = input;
    const analyzedOutputs = pageMetadata.outputs ?? [];
    return {
        pageNumber: input.pageNumber,
        totalPages: input.totalPages,
        rawWidthPx: input.raw.width,
        rawHeightPx: input.raw.height,
        pageMetadata: {
            ...pageMetadata,
            outputDiagnostics: analyzedOutputs.map(output => ({
                half: output.half,
                ...(output.contentDiagnostics === undefined
                    ? {}
                    : {contentDiagnostics: output.contentDiagnostics}),
                ...(output.textToneDiagnostics === undefined
                    ? {}
                    : {textToneDiagnostics: {
                        ...output.textToneDiagnostics,
                        inkAnchor: output.textToneDiagnostics.inkAnchor ?? null,
                        blackPoint: output.textToneDiagnostics.blackPoint ?? null,
                        slope: output.textToneDiagnostics.slope ?? null,
                    }}),
            })),
        },
        outputs: analyzedOutputs.map(output => {
            const outputWidthPx = Math.max(1, Math.round(output.cropRect.widthPx));
            const outputHeightPx = Math.max(1, Math.round(output.cropRect.heightPx));
            // Without page geometry there is no canvas to place on: the
            // output is its own crop, exactly as the assembler writes it.
            const placement = output.pdfPlacement?.preview ?? {
                canvasWidthPx: outputWidthPx,
                canvasHeightPx: outputHeightPx,
                contentWidthPx: outputWidthPx,
                contentHeightPx: outputHeightPx,
                offsetXPx: 0,
                offsetYPx: 0,
                margins: {
                    leftPx: 0,
                    topPx: 0,
                    rightPx: 0,
                    bottomPx: 0,
                },
                canvasOverflow: false,
            };
            return {
                imageData: input.raw.bytes,
                metadata: {
                    half: output.half,
                    layoutClassification: pageMetadata.layoutClassification,
                    layoutConfidence: pageMetadata.layoutConfidence,
                    sourceRegion: output.sourceRegion,
                    contentBox: output.contentBox,
                    cropRect: output.cropRect,
                    ...(output.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: output.contentDiagnostics}),
                    appliedMargins: placement.margins,
                    outputWidthPx,
                    outputHeightPx,
                    canvasWidthPx: placement.canvasWidthPx,
                    canvasHeightPx: placement.canvasHeightPx,
                    placementOffsetXPx: placement.offsetXPx,
                    placementOffsetYPx: placement.offsetYPx,
                    forwardTransform: null,
                    cutterXPx: pageMetadata.cutterXPx,
                    inputWidthPx: output.inputWidthPx,
                    inputHeightPx: output.inputHeightPx,
                    rotationDegrees: pageMetadata.rotationDegrees,
                    canvasScope: 'page',
                    resamplePasses: 0,
                    sourceDpi,
                    renderDpi,
                    requestedRenderDpi,
                    rasterScaleLimited: false,
                    canvasPolicy: matchedCanvas === undefined ? 'intrinsic' : 'strict-maximum',
                    canvasOverflow: placement.canvasOverflow,
                    matchedCanvasTargetWidthPx: matchedCanvas === undefined ? null : placement.canvasWidthPx,
                    matchedCanvasTargetHeightPx: matchedCanvas === undefined ? null : placement.canvasHeightPx,
                    matchedCanvasTargetWidthPoints: matchedCanvas?.widthPoints ?? null,
                    matchedCanvasTargetHeightPoints: matchedCanvas?.heightPoints ?? null,
                    matchedCanvasContentWidthPx: placement.contentWidthPx,
                    matchedCanvasContentHeightPx: placement.contentHeightPx,
                    matchedCanvasOpticalContentLeftPx: null,
                    matchedCanvasOpticalContentRightPx: null,
                    warnings: [
                        ...previewWarningEvents,
                        ...output.pdfPlacement?.warningEvents ?? [],
                    ].map(event => formatScanCleanupWarningEvent(event)),
                },
            };
        }),
    };
}
