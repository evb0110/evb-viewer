import type {
    IScanCleanupOptions,
    TScanCleanupOutputMode,
    TScanCleanupOutputModeSetting,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {
    isScanCleanupCompactLayeredRaster,
    type IDetectedPageRaster,
    type IPdfMrcLayers,
    type IPdfPageSize,
} from '@evb/scan-cleanup/core/types';

/**
 * A compact MRC/JBIG2 scan is already an optimized representation. Automatic
 * cleanup may spend some bytes on pages it materially changes, but it must not
 * silently flatten the whole book into full-resolution continuous-tone images.
 */
export const SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO = 2.5;
export const SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE = 8 * 1024 * 1024;
const COMPACT_SOURCE_PAGE_MAJORITY = 0.5;

/**
 * Reuse an MRC/JBIG2 source foreground only when the requested output is
 * allowed to remain bilevel. Explicit B/W needs the same contour-preserving
 * source ownership as Auto; tonal modes continue to render the composite.
 */
export function shouldExtractTrustedMrcForeground(
    documentOutputMode: TScanCleanupOutputModeSetting,
    pageOutputModeOverride: TScanCleanupOutputMode | undefined,
): boolean {
    if (pageOutputModeOverride !== undefined) {
        return pageOutputModeOverride === 'bw';
    }
    return documentOutputMode === 'auto' || documentOutputMode === 'bw';
}

export interface IScanCleanupCompactSourceBudget {
    compactLayeredPages: number;
    maxOutputBytes: number;
    sourceBytes: number;
}

export function resolveScanCleanupCompactSourceBudget(input: {
    documentPageCount: number;
    options: IScanCleanupOptions;
    rasterByPage?: ReadonlyMap<number, IDetectedPageRaster>;
    compactLayeredPageCount?: number;
    partialRun: boolean;
    sourceBytes: number;
}): IScanCleanupCompactSourceBudget | null {
    if (
        input.partialRun
        || input.options.outputMode !== 'auto'
        || !Number.isFinite(input.sourceBytes)
        || input.sourceBytes <= 0
        || input.options.pageOverrideDefaults?.outputModeOverride !== undefined
        || Object.values(input.options.pageOverrides).some(
            pageOverride => pageOverride.outputModeOverride !== undefined,
        )
    ) {
        return null;
    }
    const compactLayeredPages = input.compactLayeredPageCount ?? (() => {
        let count = 0;
        for (const [
            pageNumber,
            raster,
        ] of input.rasterByPage ?? []) {
            if (pageNumber >= 1 && pageNumber <= input.documentPageCount && isScanCleanupCompactLayeredRaster(raster)) {
                count += 1;
            }
        }
        return count;
    })();
    if (
        !Number.isSafeInteger(compactLayeredPages)
        || compactLayeredPages < 0
        || compactLayeredPages > input.documentPageCount
    ) {
        return null;
    }
    if (
        compactLayeredPages === 0
        || compactLayeredPages / input.documentPageCount < COMPACT_SOURCE_PAGE_MAJORITY
    ) {
        return null;
    }
    return {
        compactLayeredPages,
        sourceBytes: input.sourceBytes,
        maxOutputBytes: Math.ceil(Math.max(
            input.sourceBytes * SCAN_CLEANUP_COMPACT_SOURCE_MAX_BYTE_RATIO,
            input.sourceBytes + SCAN_CLEANUP_COMPACT_SOURCE_FIXED_BYTE_ALLOWANCE,
        )),
    };
}

export function assertScanCleanupCompactSourceBudget(
    outputBytes: number,
    budget: IScanCleanupCompactSourceBudget | null,
) {
    if (budget === null || outputBytes <= budget.maxOutputBytes) {
        return;
    }
    throw new Error(
        'Automatic scan cleanup refused to publish a compact layered source '
        + `that expanded from ${String(budget.sourceBytes)} to ${String(outputBytes)} bytes `
        + `(budget ${String(budget.maxOutputBytes)} bytes)`,
    );
}

const SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS = 0.001;

/**
 * Whether a page's own compact MRC layers may stand in for its rendered
 * pixels: the one rule preview and conversion apply. Returns why not, or
 * undefined when the source geometry proves the layers show the page.
 */
export function resolveSourceMrcReuseRejection(
    page: IPdfPageSize,
    detectedRaster: IDetectedPageRaster | undefined,
): string | undefined {
    const samePoints = (left: number | undefined, right: number | undefined) =>
        left !== undefined
        && right !== undefined
        && Number.isFinite(left)
        && Number.isFinite(right)
        && Math.abs(left - right) <= SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS;
    const hasMediaGeometry = page.mediaXPoints !== undefined
        && page.mediaYPoints !== undefined
        && page.mediaWidthPoints !== undefined
        && page.mediaHeightPoints !== undefined;
    const hasCropGeometry = page.cropXPoints !== undefined
        && page.cropYPoints !== undefined
        && page.cropWidthPoints !== undefined
        && page.cropHeightPoints !== undefined;
    if (page.rotation % 360 !== 0) {
        return 'source page rotation is not zero';
    }
    if (page.xPoints !== 0 || page.yPoints !== 0) {
        return 'source page origin is not zero';
    }
    if (!hasMediaGeometry || !samePoints(page.mediaXPoints, 0) || !samePoints(page.mediaYPoints, 0)) {
        return 'source MediaBox geometry is unavailable or offset';
    }
    if (
        !samePoints(page.mediaWidthPoints, page.widthPoints)
        || !samePoints(page.mediaHeightPoints, page.heightPoints)
    ) {
        return 'source MediaBox does not match the displayed page';
    }
    if (hasCropGeometry && (
        !samePoints(page.cropXPoints, page.xPoints)
        || !samePoints(page.cropYPoints, page.yPoints)
        || !samePoints(page.cropWidthPoints, page.widthPoints)
        || !samePoints(page.cropHeightPoints, page.heightPoints)
    )) {
        return 'source CropBox does not match the displayed page';
    }
    if (
        detectedRaster?.width === undefined
        || detectedRaster.height === undefined
        || detectedRaster.width <= 0
        || detectedRaster.height <= 0
        || detectedRaster.dpi <= 0
        || !samePoints(detectedRaster.width / detectedRaster.dpi * 72, page.widthPoints)
        || !samePoints(detectedRaster.height / detectedRaster.dpi * 72, page.heightPoints)
    ) {
        return 'dominant source image placement is not proven';
    }
    if (
        !samePoints(page.dominantImageWidthPoints, page.widthPoints)
        || !samePoints(page.dominantImageHeightPoints, page.heightPoints)
        || page.dominantImageWidthPx === undefined
        || page.dominantImageHeightPx === undefined
        || page.dominantImageWidthPx <= 0
        || page.dominantImageHeightPx <= 0
    ) {
        return 'dominant source image placement is not proven';
    }
    return undefined;
}

/** Whether extracted layers cover the displayed page, or why not. */
export function resolveSourceMrcLayerRejection(
    page: IPdfPageSize,
    layers: IPdfMrcLayers,
): string | undefined {
    const widthPoints = layers.foregroundWidth / layers.foregroundDpi * 72;
    const heightPoints = layers.foregroundHeight / layers.foregroundDpi * 72;
    if (
        !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || Math.abs(widthPoints - page.widthPoints) > SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS
        || Math.abs(heightPoints - page.heightPoints) > SOURCE_MRC_GEOMETRY_TOLERANCE_POINTS
    ) {
        return 'extracted foreground dimensions do not match the displayed page';
    }
    return undefined;
}
