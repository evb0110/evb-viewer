/**
 * Platform-neutral final output composition. Given the engine's published
 * metadata for one output and the planes it wrote, these rules decide the PDF
 * page each output becomes, whether the source page is retained instead, and
 * how the run reports it. Plane references are opaque: desktop passes file
 * paths, the browser passes in-memory planes.
 */
import type {
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    INativeScanCleanupPdfPlacementV3,
    TScanCleanupOutputMode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {
    IDetectedPageRaster,
    IPdfPageSize,
    IRunScanCleanupPipelineRequest,
    IScanCleanupOutputMapping,
    IScanCleanupOutputPageForSummary,
    IScanCleanupRepresentationReport,
} from '@evb/scan-cleanup/core/types';
import {buildScanCleanupSourceMrcForegroundPdfMatrix} from '@evb/scan-cleanup/core/buildScanCleanupSourceMrcForegroundPdfMatrix';
import {
    resolveTonalJpegQuality,
    SCAN_CLEANUP_COLOR_JPEG_QUALITY,
    SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY,
} from '@evb/scan-cleanup/core/policy/effectiveOptions';

export interface IScanCleanupPreservedSource {
    reason:
        | 'auto-color-compact-layered-no-raster-change'
        | 'auto-mixed-trusted-mrc-tone-preserved'
        | 'mixed-layer-validation-fallback';
    sourcePageIndex: number;
    rotationQuarterTurns: number;
    cropRect: INativeScanCleanupPdfPlacementV3['cropRect'];
    contentTransform: NonNullable<INativeScanCleanupPdfPlacementV3['contentTransform']>;
}

export interface IScanCleanupRenderedOutput<TPlane> {
    sourcePageNumber: number;
    path: TPlane;
    bilevelPath?: TPlane;
    backgroundPath?: TPlane;
    foregroundMaskPath?: TPlane;
    foregroundAlphaPath?: TPlane;
    backgroundIsColor?: boolean;
    dpi: number;
    resolvedOutputMode: TScanCleanupOutputMode;
    metadata: INativeScanCleanupOutputMetadataV3;
    preservedSource?: IScanCleanupPreservedSource;
}

/** The source-MRC layers a page reuses, with geometry the matrix needs. */
export interface IScanCleanupSourceMrcLayers<TPlane> {
    backgroundDpi: number;
    foregroundDpi: number;
    foregroundWidth: number;
    foregroundHeight: number;
    foregroundPath: TPlane;
    selectionMaskPath: TPlane;
    selectionMaskDecode: 'default' | 'inverted';
}

export function sourceMrcForegroundPdfMatrix<TPlane>(
    output: IScanCleanupRenderedOutput<TPlane>,
    layers: IScanCleanupSourceMrcLayers<TPlane>,
    pageWidthPoints: number,
    pageHeightPoints: number,
) {
    const metadata = output.metadata;
    const matrix = metadata.forwardTransform?.matrix;
    if (
        matrix === undefined
        || metadata.inputWidthPx === undefined
        || metadata.inputHeightPx === undefined
        || metadata.outputWidthPx <= 0
        || metadata.outputHeightPx <= 0
        || (metadata.intrinsicRasterWidthPx !== undefined && metadata.intrinsicRasterWidthPx <= 0)
        || (metadata.intrinsicRasterHeightPx !== undefined && metadata.intrinsicRasterHeightPx <= 0)
        || metadata.rotationDegrees !== 0
        || metadata.dewarpMapping != null
    ) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} cannot preserve its source MRC foreground `
            + 'because its cleanup geometry is not affine in the source orientation',
        );
    }
    const pdfMatrix = buildScanCleanupSourceMrcForegroundPdfMatrix(
        metadata,
        layers,
        pageWidthPoints,
        pageHeightPoints,
    );
    if (!pdfMatrix.every(Number.isFinite)) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} produced a non-finite source MRC transform`,
        );
    }
    return pdfMatrix;
}

export function resolveCompactSourcePreservation<TPlane>(
    request: IRunScanCleanupPipelineRequest,
    sourcePageNumber: number,
    pageMetadata: INativeScanCleanupPageMetadataV3,
    output: Omit<IScanCleanupRenderedOutput<TPlane>, 'preservedSource'>,
    pageSize: IPdfPageSize | undefined,
    sourceRaster: IDetectedPageRaster | undefined,
): IScanCleanupPreservedSource | undefined {
    const pageOverride = getScanCleanupPageOverride(
        request.options.pageOverrides,
        requirePageNumber(sourcePageNumber),
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    // Auto is allowed to retain a compact source page when cleanup made no
    // raster change. JPX/JBIG2 are supported by EVB Viewer's configured PDF.js
    // runtime and by the reference desktop renderers; transcoding them merely
    // for a separate no-WASM review surface adds no quality and can multiply
    // the document size. That review surface is classified separately by the
    // generated-PDF verifier.
    const configuredMode = pageOverride.outputModeOverride ?? request.options.outputMode;
    const manualZones = pageOverride.manualZones;
    const preservesTrustedMrcTone = output.resolvedOutputMode === 'mixed'
        && output.metadata.trustedMrcBackgroundPreserved === true;
    if (
        configuredMode !== 'auto'
        || (output.resolvedOutputMode !== 'color' && !preservesTrustedMrcTone)
        || sourceRaster?.hasBilevelLayer !== true
        || sourceRaster.backgroundDpi === undefined
        || !Number.isFinite(sourceRaster.backgroundDpi)
        || sourceRaster.backgroundDpi <= 0
        || pageSize === undefined
        || pageSize.rotation !== 0
        || pageOverride.rotationDegrees !== 0
        || pageMetadata.layoutClassification !== 'single-uncut-page'
        || pageMetadata.outputCount !== 1
        || output.metadata.half !== 'full'
        || output.metadata.skewApplied
        || output.metadata.dewarpModel != null
        || (!preservesTrustedMrcTone && output.metadata.illuminationNormalized === true)
        || (!preservesTrustedMrcTone && output.metadata.textToneDiagnostics?.applied === true)
        || (!preservesTrustedMrcTone && output.metadata.binarizationMode != null)
        || pageOverride.manualSkewDegrees !== undefined
        || (manualZones?.picture.length ?? 0) > 0
        || (manualZones?.fill.length ?? 0) > 0
        || output.metadata.sourcePdfPlacement?.contentTransform === undefined
    ) {
        return undefined;
    }
    return {
        reason: preservesTrustedMrcTone
            ? 'auto-mixed-trusted-mrc-tone-preserved'
            : 'auto-color-compact-layered-no-raster-change',
        sourcePageIndex: sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        cropRect: output.metadata.sourcePdfPlacement.cropRect,
        contentTransform: output.metadata.sourcePdfPlacement.contentTransform,
    };
}

export function resolveFullSourcePagePreservation(
    sourcePageNumber: number,
    pageSize: IPdfPageSize | undefined,
): IScanCleanupPreservedSource | undefined {
    if (
        pageSize === undefined
        || !Number.isFinite(pageSize.xPoints)
        || !Number.isFinite(pageSize.yPoints)
        || !Number.isFinite(pageSize.widthPoints)
        || pageSize.widthPoints <= 0
        || !Number.isFinite(pageSize.heightPoints)
        || pageSize.heightPoints <= 0
    ) {
        return undefined;
    }
    return {
        reason: 'mixed-layer-validation-fallback',
        sourcePageIndex: sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        cropRect: {
            x: pageSize.xPoints,
            y: pageSize.yPoints,
            width: pageSize.widthPoints,
            height: pageSize.heightPoints,
        },
        contentTransform: {
            scale: 1,
            translateX: 0,
            translateY: 0,
        },
    };
}

interface IRasterDimensions {
    width: number;
    height: number;
}

/**
 * The plane sizes a mixed output must have for its metadata to describe it.
 * A layer of any other size cannot be composed onto the page it claims.
 */
export function resolveScanCleanupMixedLayerExpectation(
    metadata: INativeScanCleanupOutputMetadataV3,
    renderDpi: number,
    pageNumber: number,
) {
    const backgroundDpi = metadata.layeredBackgroundDpi;
    const foregroundDpi = metadata.layeredForegroundKind === 'soft-alpha'
        ? metadata.layeredForegroundDpi
        : renderDpi;
    if (
        !Number.isFinite(renderDpi)
        || renderDpi <= 0
        || backgroundDpi === undefined
        || !Number.isFinite(backgroundDpi)
        || backgroundDpi <= 0
        || foregroundDpi === undefined
        || !Number.isFinite(foregroundDpi)
        || foregroundDpi <= 0
    ) {
        throw new Error(`Page ${pageNumber} mixed layer DPI metadata is invalid`);
    }
    const matchedTarget = (points: number | null | undefined) => (
        points !== null && points !== undefined && Number.isFinite(points) && points > 0 ? points : undefined
    );
    const targetWidthPoints = matchedTarget(metadata.matchedCanvasTargetWidthPoints);
    const targetHeightPoints = matchedTarget(metadata.matchedCanvasTargetHeightPoints);
    return {
        background: {
            width: Math.max(1, targetWidthPoints === undefined
                ? Math.round(metadata.canvasWidthPx * backgroundDpi / renderDpi)
                : Math.round(targetWidthPoints / 72 * backgroundDpi)),
            height: Math.max(1, targetHeightPoints === undefined
                ? Math.round(metadata.canvasHeightPx * backgroundDpi / renderDpi)
                : Math.round(targetHeightPoints / 72 * backgroundDpi)),
        },
        foreground: {
            width: Math.max(1, Math.round(metadata.canvasWidthPx * foregroundDpi / renderDpi)),
            height: Math.max(1, Math.round(metadata.canvasHeightPx * foregroundDpi / renderDpi)),
        },
    };
}

/** Null when both layers match; otherwise the mismatch, worded for the run's report. */
export function describeScanCleanupMixedLayerMismatch(
    expected: ReturnType<typeof resolveScanCleanupMixedLayerExpectation>,
    background: IRasterDimensions,
    foreground: IRasterDimensions,
) {
    if (
        foreground.width === expected.foreground.width
        && foreground.height === expected.foreground.height
        && background.width === expected.background.width
        && background.height === expected.background.height
    ) {
        return null;
    }
    return `(background ${background.width}x${background.height}, `
        + `expected ${expected.background.width}x${expected.background.height}; `
        + `foreground ${foreground.width}x${foreground.height}, `
        + `expected ${expected.foreground.width}x${expected.foreground.height})`;
}

export function resolveBlankOutputHalves<TPlane>(
    pageMetadata: INativeScanCleanupPageMetadataV3,
    pageOutputPages: readonly IScanCleanupRenderedOutput<TPlane>[],
    missingOutputCount: number,
): Array<IScanCleanupOutputMapping['half']> {
    if (missingOutputCount <= 0) {
        return [];
    }
    if (pageMetadata.layoutClassification !== 'two-page-spread') {
        return Array.from({length: missingOutputCount}, () => 'full');
    }
    const producedHalves = new Set(
        pageOutputPages
            .map(output => output.metadata.half)
            .filter((half): half is 'left' | 'right' => half === 'left' || half === 'right'),
    );
    const unproducedHalves = ([
        'left',
        'right',
    ] as const).filter(half => !producedHalves.has(half));
    return Array.from(
        {length: missingOutputCount},
        (_, index) => unproducedHalves[index] ?? 'full',
    );
}

/**
 * Order one source page's produced outputs and record the halves it did not
 * produce. Mutates the caller's empty-output mappings, as desktop and browser
 * both accumulate one run-level list.
 */
export function collectScanCleanupPageOutputs<TPlane>(
    {
        request, sourcePageNumber, pageMetadata, pageOutputPages, intentionallyBlankOutputCount, emptyOutputMappings,
    }: {
        request: IRunScanCleanupPipelineRequest;
        sourcePageNumber: number;
        pageMetadata: INativeScanCleanupPageMetadataV3;
        pageOutputPages: IScanCleanupRenderedOutput<TPlane>[];
        intentionallyBlankOutputCount: number;
        emptyOutputMappings: IScanCleanupOutputMapping[];
    },
) {
    if (request.options.readingOrder === 'rtl' && pageMetadata.layoutClassification === 'two-page-spread') {
        pageOutputPages.reverse();
    }
    const emptyMapping = (half: IScanCleanupOutputMapping['half']): IScanCleanupOutputMapping => ({
        sourcePage: sourcePageNumber,
        half,
        outputOrdinal: null,
        rotationDegrees: pageMetadata.rotationDegrees,
        excluded: false,
        blank: true,
    });
    if (intentionallyBlankOutputCount > 0 && pageOutputPages.length > 0) {
        for (const half of resolveBlankOutputHalves(pageMetadata, pageOutputPages, intentionallyBlankOutputCount)) {
            emptyOutputMappings.push(emptyMapping(half));
        }
    } else if (pageOutputPages.length === 0) {
        emptyOutputMappings.push(emptyMapping('full'));
    }
    return pageOutputPages;
}

export function validatePdfImagePlacement(
    placement: NonNullable<INativeScanCleanupOutputMetadataV3['pdfImagePlacement']>,
    pageWidthPoints: number,
    pageHeightPoints: number,
    pageNumber: number,
) {
    const values = [
        placement.xPoints,
        placement.yPoints,
        placement.widthPoints,
        placement.heightPoints,
    ];
    const tolerancePoints = 0.0001;
    if (
        !values.every(Number.isFinite)
        || placement.xPoints < 0
        || placement.yPoints < 0
        || placement.widthPoints <= 0
        || placement.heightPoints <= 0
        || placement.xPoints + placement.widthPoints > pageWidthPoints + tolerancePoints
        || placement.yPoints + placement.heightPoints > pageHeightPoints + tolerancePoints
    ) {
        throw new Error(`Page ${String(pageNumber)} PDF image placement is outside its MediaBox`);
    }
    return values;
}

type TPageSize = readonly [widthPoints: number, heightPoints: number];

export type TScanCleanupCombinePage<TPlane> =
    | {
        kind: 'image-bilevel';
        pageSize: TPageSize;
        bilevel: TPlane
    }
    | {
        kind: 'soft-layered-jpeg';
        pageSize: TPageSize;
        quality: number;
        background: TPlane;
        foregroundAlpha: TPlane
    }
    | {
        kind: 'affine-masked-layered-jpeg';
        pageSize: TPageSize;
        quality: number;
        background: TPlane;
        foreground: TPlane;
        selectionMask: TPlane;
        matrix: readonly number[];
        selectionMaskDecode: 'default' | 'inverted';
    }
    | {
        kind: 'layered-jpeg';
        pageSize: TPageSize;
        quality: number;
        background: TPlane;
        foregroundMask: TPlane
    }
    | {
        kind: 'image';
        pageSize: TPageSize;
        composite: TPlane;
        placement?: readonly number[]
    }
    | {
        kind: 'image-jpeg';
        pageSize: TPageSize;
        quality: number;
        composite: TPlane;
        placement?: readonly number[]
    };

/**
 * The composition one rendered output becomes: the page size it occupies,
 * the layer topology and compression. The finished bilevel plane is embedded
 * as is; it is never binarized a second time.
 */
export function planScanCleanupCombinePage<TPlane>(
    output: IScanCleanupRenderedOutput<TPlane>,
    sourceMrcLayers: IScanCleanupSourceMrcLayers<TPlane> | undefined,
): TScanCleanupCombinePage<TPlane> {
    const pageWidthPoints = output.metadata.matchedCanvasTargetWidthPoints
        ?? output.metadata.canvasWidthPx / output.dpi * 72;
    const pageHeightPoints = output.metadata.matchedCanvasTargetHeightPoints
        ?? output.metadata.canvasHeightPx / output.dpi * 72;
    const pageSize = [
        pageWidthPoints,
        pageHeightPoints,
    ] as const;
    const imagePlacement = output.metadata.pdfImagePlacement;
    if (
        imagePlacement !== undefined
        && (output.bilevelPath !== undefined || output.backgroundPath !== undefined)
    ) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} attached continuous-tone placement `
            + 'to a bilevel or layered page',
        );
    }
    if (output.bilevelPath !== undefined) {
        return {
            kind: 'image-bilevel',
            pageSize,
            bilevel: output.bilevelPath,
        };
    }
    const layeredQuality = output.backgroundIsColor
        ? SCAN_CLEANUP_COLOR_JPEG_QUALITY
        : SCAN_CLEANUP_GRAYSCALE_JPEG_QUALITY;
    if (output.backgroundPath !== undefined && output.foregroundAlphaPath !== undefined) {
        return {
            kind: 'soft-layered-jpeg',
            pageSize,
            quality: layeredQuality,
            background: output.backgroundPath,
            foregroundAlpha: output.foregroundAlphaPath,
        };
    }
    if (output.backgroundPath !== undefined && output.foregroundMaskPath !== undefined) {
        if (output.metadata.layeredForegroundKind === 'source-mrc') {
            if (sourceMrcLayers === undefined) {
                throw new Error(
                    `Page ${String(output.sourcePageNumber)} published source-MRC metadata `
                    + 'without its extracted source layers',
                );
            }
            return {
                kind: 'affine-masked-layered-jpeg',
                pageSize,
                quality: layeredQuality,
                background: output.backgroundPath,
                foreground: sourceMrcLayers.foregroundPath,
                selectionMask: sourceMrcLayers.selectionMaskPath,
                matrix: sourceMrcForegroundPdfMatrix(output, sourceMrcLayers, pageWidthPoints, pageHeightPoints),
                selectionMaskDecode: sourceMrcLayers.selectionMaskDecode,
            };
        }
        return {
            kind: 'layered-jpeg',
            pageSize,
            quality: layeredQuality,
            background: output.backgroundPath,
            foregroundMask: output.foregroundMaskPath,
        };
    }
    const placement = imagePlacement === undefined
        ? undefined
        : validatePdfImagePlacement(imagePlacement, pageWidthPoints, pageHeightPoints, output.sourcePageNumber);
    const jpegQuality = resolveTonalJpegQuality(output.resolvedOutputMode);
    return jpegQuality === undefined
        ? {
            kind: 'image',
            pageSize,
            composite: output.path,
            ...(placement === undefined ? {} : {placement}),
        }
        : {
            kind: 'image-jpeg',
            pageSize,
            quality: jpegQuality,
            composite: output.path,
            ...(placement === undefined ? {} : {placement}),
        };
}

/** The desktop combine manifest line for one planned page. */
export function serializeScanCleanupCombinePage(page: TScanCleanupCombinePage<string>) {
    const pageSize = page.pageSize.map(value => value.toFixed(6));
    const placement = (values: readonly number[] | undefined) => values?.map(value => value.toFixed(6)) ?? [];
    switch (page.kind) {
        case 'image-bilevel':
            return [
                page.kind,
                ...pageSize,
                page.bilevel,
            ].join('\t');
        case 'soft-layered-jpeg':
            return [
                page.kind,
                ...pageSize,
                page.quality,
                page.background,
                page.foregroundAlpha,
            ].join('\t');
        case 'affine-masked-layered-jpeg':
            return [
                page.kind,
                ...pageSize,
                page.quality,
                page.background,
                page.foreground,
                page.selectionMask,
                ...page.matrix.map(value => value.toFixed(10)),
                page.selectionMaskDecode,
            ].join('\t');
        case 'layered-jpeg':
            return [
                page.kind,
                ...pageSize,
                page.quality,
                page.background,
                page.foregroundMask,
            ].join('\t');
        case 'image':
            return [
                page.kind,
                ...pageSize,
                page.composite,
                ...placement(page.placement),
            ].join('\t');
        case 'image-jpeg':
            return [
                page.kind,
                ...pageSize,
                page.quality,
                page.composite,
                ...placement(page.placement),
            ].join('\t');
    }
}

export function buildScanCleanupOutputMappings<TPlane>(
    outputPages: readonly IScanCleanupRenderedOutput<TPlane>[],
    emptyOutputMappings: readonly IScanCleanupOutputMapping[],
): IScanCleanupOutputMapping[] {
    return [
        ...outputPages.map((output, outputIndex) => ({
            sourcePage: output.sourcePageNumber,
            half: output.metadata.half ?? 'full',
            outputOrdinal: outputIndex + 1,
            rotationDegrees: output.metadata.rotationDegrees,
            excluded: false,
            blank: false,
        })),
        ...emptyOutputMappings,
    ];
}

/** One output page's representation record for the run's report. */
export function buildScanCleanupRepresentationPage<TPlane>(
    output: IScanCleanupRenderedOutput<TPlane>,
    outputIndex: number,
    {
        sourceDpi, sourceRaster, streamBytes,
    }: {
        sourceDpi: number;
        sourceRaster: IDetectedPageRaster | undefined;
        streamBytes: IScanCleanupOutputPageForSummary['streamBytes'] | undefined;
    },
): IScanCleanupRepresentationReport['pages'][number] {
    const metadata = output.metadata;
    return {
        outputPageNumber: outputIndex + 1,
        outputOrdinal: outputIndex + 1,
        sourcePageNumber: output.sourcePageNumber,
        semanticMode: output.resolvedOutputMode,
        representation: output.preservedSource !== undefined
            ? 'preserved-compact-source'
            : output.bilevelPath !== undefined
                ? 'bilevel'
                : output.backgroundPath !== undefined
                    ? 'mixed'
                    : output.resolvedOutputMode,
        preservationReason: output.preservedSource?.reason ?? null,
        sourceDpi,
        sourceBackgroundDpi: sourceRaster?.backgroundDpi ?? null,
        renderDpi: output.dpi,
        illuminationNormalized: metadata.illuminationNormalized === true,
        textToneApplied: metadata.textToneDiagnostics?.applied === true,
        binarizationMode: metadata.binarizationMode ?? null,
        half: metadata.half ?? 'full',
        rotationDegrees: metadata.rotationDegrees,
        excluded: false,
        blank: false,
        renderGeometry: {
            canvasHeightPx: metadata.canvasHeightPx,
            canvasWidthPx: metadata.canvasWidthPx,
            cropRect: metadata.cropRect,
            dewarpMapping: metadata.dewarpMapping,
            ...(metadata.foldClipLeftPx === undefined ? {} : {foldClipLeftPx: metadata.foldClipLeftPx}),
            ...(metadata.foldClipRightPx === undefined ? {} : {foldClipRightPx: metadata.foldClipRightPx}),
            dewarped: metadata.dewarpMapping != null,
            forwardTransform: metadata.forwardTransform,
            inputHeightPx: metadata.inputHeightPx,
            inputWidthPx: metadata.inputWidthPx,
            ...(metadata.intrinsicRasterHeightPx === undefined
                ? {}
                : {intrinsicRasterHeightPx: metadata.intrinsicRasterHeightPx}),
            ...(metadata.intrinsicRasterWidthPx === undefined
                ? {}
                : {intrinsicRasterWidthPx: metadata.intrinsicRasterWidthPx}),
            matchedCanvasContentHeightPx: metadata.matchedCanvasContentHeightPx,
            matchedCanvasContentWidthPx: metadata.matchedCanvasContentWidthPx,
            ...(metadata.matchedCanvasIntrinsicOverflowLeftPx === undefined
                ? {}
                : {matchedCanvasIntrinsicOverflowLeftPx: metadata.matchedCanvasIntrinsicOverflowLeftPx}),
            ...(metadata.matchedCanvasIntrinsicOverflowRightPx === undefined
                ? {}
                : {matchedCanvasIntrinsicOverflowRightPx: metadata.matchedCanvasIntrinsicOverflowRightPx}),
            ...(metadata.matchedCanvasIntrinsicOverflowTopPx === undefined
                ? {}
                : {matchedCanvasIntrinsicOverflowTopPx: metadata.matchedCanvasIntrinsicOverflowTopPx}),
            outputHeightPx: metadata.outputHeightPx,
            outputWidthPx: metadata.outputWidthPx,
            placementOffsetXPx: metadata.placementOffsetXPx,
            placementOffsetYPx: metadata.placementOffsetYPx,
            sourceRegion: metadata.sourceRegion,
        },
        ...(streamBytes === undefined ? {} : {streamBytes}),
    };
}
