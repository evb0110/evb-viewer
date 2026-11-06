import {isRecord} from '@contracts/runtimeGuards';
import {
    detectPageRasterFromPageSize,
    detectSourceDpiFromPageSizes,
    type IPdfPageSize,
    type IScanCleanupRasterRenderLimits,
} from '@evb/scan-cleanup/core/types';
import {SCAN_CLEANUP_MAX_DIMENSION_PX} from '@contracts/scan-cleanup/inputLimits';

/*
 * Page geometry and raster resolution, decided from a page's geometry record
 * alone. Desktop reads that record from the page-size sidecar and the browser
 * from the same Rust reader over WebAssembly; both render, detect and preview
 * a page at the resolutions these functions choose. No I/O lives here.
 */

export const DETECTION_DPI = 150;
export const PREVIEW_DPI = DETECTION_DPI;

/**
 * The DPI of one page's canonical analysis plane. Detection classifies a page
 * on it, and preview and final cleanup route the same page on it, so it is a
 * function of the page's geometry record alone, which every stage reads from
 * the same page-size reader: 150 DPI, never finer than the page's full-page
 * scan (rendering a 72-ppi scan at 150 only interpolates pixels), and coarse
 * enough for the raster to fit the cap every producer and reader applies. A
 * page without a full-page image keeps 150: a smaller image on it says nothing
 * about the resolution the rest of the page needs.
 */
export function resolveScanCleanupAnalysisDpi(pageSize: IPdfPageSize | undefined) {
    const sourceDpi = pageSize === undefined ? undefined : detectPageRasterFromPageSize(pageSize)?.dpi;
    let dpi = sourceDpi !== undefined && Number.isFinite(sourceDpi) && sourceDpi >= 1
        ? Math.min(DETECTION_DPI, Math.floor(sourceDpi))
        : DETECTION_DPI;
    const pageArea = (pageSize?.widthPoints ?? 0) * (pageSize?.heightPoints ?? 0);
    if (pageSize === undefined || !Number.isFinite(pageArea) || pageArea <= 0) {
        return dpi;
    }
    dpi = Math.max(1, Math.min(
        dpi,
        Math.floor(72 * Math.sqrt(SCAN_CLEANUP_RASTER_MAX_PIXELS / pageArea)),
        Math.floor(72 * SCAN_CLEANUP_MAX_DIMENSION_PX / Math.max(pageSize.widthPoints, pageSize.heightPoints)),
    ));
    // Rendered dimensions round up, so the closed form can overshoot by a row.
    for (;;) {
        const limits = resolveScanCleanupRasterRenderLimits(pageSize, dpi);
        if (dpi === 1 || limits.expectedWidthPx * limits.expectedHeightPx <= SCAN_CLEANUP_RASTER_MAX_PIXELS) {
            return dpi;
        }
        dpi -= 1;
    }
}
// Native mode selection, preview, and final rendering share this canonical
// analysis grid. The separate working raster remains free to follow source DPI.
const BASE_PREVIEW_MAX_PIXELS = 4_000_000;

/**
 * Binary cleanup needs the source's stroke samples even though the UI presents
 * the result on the smaller preview canvas. Thresholding the already reduced
 * 150-DPI raster loses subpixel stroke evidence and makes neighboring words
 * alternate between heavy and light. Native therefore cleans binary-capable
 * previews at up to 2x the display DPI; the renderer's ordinary placement
 * downsample is the same final step used when a 300-DPI conversion is viewed.
 * Tonal previews keep the inexpensive display grid because they do not
 * threshold those samples.
 */
export function resolvePreviewProcessingDpi({
    displayDpi,
    outputMode,
    sourceDpi,
}: {
    displayDpi: number;
    outputMode: 'bw' | 'color' | 'grayscale' | 'mixed' | undefined;
    sourceDpi: number;
}) {
    const binaryCapable = outputMode === undefined || outputMode === 'bw' || outputMode === 'mixed';
    if (!binaryCapable) {
        return displayDpi;
    }
    return Math.max(displayDpi, Math.floor(Math.min(sourceDpi, displayDpi * 2)));
}

export function resolvePagePreviewDpi(
    pageSize: IPdfPageSize,
    requestedDpi: number,
) {
    const pageAreaPoints = pageSize.widthPoints * pageSize.heightPoints;
    if (!Number.isFinite(pageAreaPoints) || pageAreaPoints <= 0) {
        return requestedDpi;
    }
    const pixelBoundDpi = 72 * Math.sqrt(BASE_PREVIEW_MAX_PIXELS / pageAreaPoints);
    return Math.max(1, Math.floor(Math.min(requestedDpi, pixelBoundDpi)));
}

/** Resolve one page's bounded preview raster DPI without a page-sized plan. */
export function resolveScanCleanupPagePreviewDpi(
    pageSize: IPdfPageSize,
    sourceDpi: number | null | undefined,
) {
    const normalizedSourceDpi = Number.isFinite(sourceDpi) && (sourceDpi ?? 0) > 0
        ? sourceDpi!
        : PREVIEW_DPI;
    return resolvePagePreviewDpi(
        pageSize,
        Math.min(PREVIEW_DPI, normalizedSourceDpi),
    );
}

export function resolvePreviewRasterPlan(
    pageSizes: readonly IPdfPageSize[] | null,
    sourceDpiByPage: ReadonlyMap<number, number> = new Map(),
) {
    const detected = pageSizes === null ? null : detectSourceDpiFromPageSizes(pageSizes);
    const pageDpiByNumber = new Map<number, number>();
    for (const pageSize of pageSizes ?? []) {
        const sourceRaster = detected?.getPageRaster(pageSize.pageNumber);
        if (!(sourceRaster instanceof Promise) && sourceRaster !== undefined) {
            pageDpiByNumber.set(pageSize.pageNumber, sourceRaster.dpi);
        }
    }
    let documentDpi = detected?.documentDpi ?? 0;
    for (const [
        pageNumber,
        sourceDpi,
    ] of sourceDpiByPage) {
        if (!Number.isFinite(sourceDpi) || sourceDpi <= 0) continue;
        pageDpiByNumber.set(pageNumber, Math.max(pageDpiByNumber.get(pageNumber) ?? 0, sourceDpi));
        documentDpi = Math.max(documentDpi, sourceDpi);
    }
    documentDpi = documentDpi > 0 ? documentDpi : PREVIEW_DPI;
    const dpi = Math.min(PREVIEW_DPI, documentDpi);
    const renderDpiByPageNumber = new Map<number, number>();
    for (const pageSize of pageSizes ?? []) {
        const sourceDpi = pageDpiByNumber.get(pageSize.pageNumber);
        const requestedDpi = Math.min(PREVIEW_DPI, sourceDpi ?? dpi);
        const renderDpi = resolvePagePreviewDpi(pageSize, requestedDpi);
        renderDpiByPageNumber.set(pageSize.pageNumber, renderDpi);
    }
    return {
        dpi,
        pageDpiByNumber,
        renderDpiByPageNumber,
    };
}

export const SCAN_CLEANUP_RASTER_MAX_PIXELS = 45_000_000;

export function resolveScanCleanupRasterRenderLimits(
    pageSize: IPdfPageSize | undefined,
    dpi: number,
    maxPixels = SCAN_CLEANUP_RASTER_MAX_PIXELS,
    crop?: {
        width: number;
        height: number;
    },
): IScanCleanupRasterRenderLimits {
    if (pageSize === undefined) {
        const scaleToFitPx = Math.max(1, Math.floor(Math.sqrt(maxPixels)));
        return {
            expectedWidthPx: scaleToFitPx,
            expectedHeightPx: scaleToFitPx,
            maxPixels,
            maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
            scaleToFitPx,
        };
    }
    const swapsAxes = Math.abs(Math.round(pageSize.rotation / 90)) % 2 === 1;
    return {
        expectedWidthPx: crop?.width ?? Math.max(1, Math.ceil(
            (swapsAxes ? pageSize.heightPoints : pageSize.widthPoints) * dpi / 72,
        )),
        expectedHeightPx: crop?.height ?? Math.max(1, Math.ceil(
            (swapsAxes ? pageSize.widthPoints : pageSize.heightPoints) * dpi / 72,
        )),
        maxPixels,
        maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
    };
}

const LANDSCAPE_GEOMETRY_RATIO = 1.1;
/** A retry candidate must lose at least this share of its physical paper. */
const MATERIAL_CROP_AREA_RATIO = 0.8;

export function invalidPdfPageNumbering(reason: string) {
    return new Error(`evb-pdf-page-ops returned invalid page numbering: ${reason}`);
}

/**
 * The geometry a page carries: the page view (CropBox intersected with
 * MediaBox) in PDF user space, plus the display rotation that view is presented
 * under. It is the same rectangle `split-pages` writes back and the same one
 * `pdftoppm -cropbox` rasterizes, so a canvas measured from it is the canvas the
 * assembled document ends up carrying.
 */
export function decodePdfPageSizeFinite(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The most page records one bounded page-size or detection read returns. */
export const PDF_PAGE_SIZE_STORE_MAX_READ_PAGES = 1_024;

export function toCropBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (
        page.cropXPoints === undefined
        || page.cropYPoints === undefined
        || page.cropWidthPoints === undefined
        || page.cropHeightPoints === undefined
    ) {
        return page;
    }
    return {
        ...page,
        xPoints: page.cropXPoints,
        yPoints: page.cropYPoints,
        widthPoints: page.cropWidthPoints,
        heightPoints: page.cropHeightPoints,
        renderBox: 'cropbox',
    };
}

function isLandscape(widthPoints: number, heightPoints: number) {
    return widthPoints >= heightPoints * LANDSCAPE_GEOMETRY_RATIO;
}

function hasMediaGeometry(page: IPdfPageSize): page is IPdfPageSize & {
    mediaXPoints: number;
    mediaYPoints: number;
    mediaWidthPoints: number;
    mediaHeightPoints: number;
} {
    return page.mediaXPoints !== undefined
        && page.mediaYPoints !== undefined
        && page.mediaWidthPoints !== undefined
        && page.mediaHeightPoints !== undefined
        && Number.isFinite(page.mediaXPoints)
        && Number.isFinite(page.mediaYPoints)
        && Number.isFinite(page.mediaWidthPoints)
        && Number.isFinite(page.mediaHeightPoints)
        && page.mediaWidthPoints > 0
        && page.mediaHeightPoints > 0;
}

export function isCropBoxOrientationMismatch(page: IPdfPageSize) {
    return page.heightPoints >= page.widthPoints * LANDSCAPE_GEOMETRY_RATIO
        && hasMediaGeometry(page)
        && isLandscape(page.mediaWidthPoints, page.mediaHeightPoints);
}

/**
 * A large area difference alone is not enough to render a page twice. This
 * predicate is for the native retry after a first-pass classification has
 * supplied content evidence, not for the ordinary renderer fallback.
 */
export function isMateriallySmallerCropBox(page: IPdfPageSize) {
    if (!hasMediaGeometry(page)) {
        return false;
    }
    const cropArea = page.widthPoints * page.heightPoints;
    const mediaArea = page.mediaWidthPoints * page.mediaHeightPoints;
    return Number.isFinite(cropArea)
        && Number.isFinite(mediaArea)
        && cropArea > 0
        && mediaArea > 0
        && cropArea / mediaArea < MATERIAL_CROP_AREA_RATIO;
}

export function toMediaBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (!hasMediaGeometry(page)) {
        return page;
    }
    return {
        ...page,
        xPoints: page.mediaXPoints,
        yPoints: page.mediaYPoints,
        widthPoints: page.mediaWidthPoints,
        heightPoints: page.mediaHeightPoints,
        renderBox: 'mediabox',
    };
}

function decodeOptionalPdfBox(page: Record<string, unknown>, prefix: 'media' | 'crop') {
    const xPoints = decodePdfPageSizeFinite(page[`${prefix}XPoints`]);
    const yPoints = decodePdfPageSizeFinite(page[`${prefix}YPoints`]);
    const widthPoints = decodePdfPageSizeFinite(page[`${prefix}WidthPoints`]);
    const heightPoints = decodePdfPageSizeFinite(page[`${prefix}HeightPoints`]);
    if (
        xPoints === null
        || yPoints === null
        || widthPoints === null
        || heightPoints === null
        || widthPoints <= 0
        || heightPoints <= 0
    ) {
        return undefined;
    }
    return {
        [`${prefix}XPoints`]: xPoints,
        [`${prefix}YPoints`]: yPoints,
        [`${prefix}WidthPoints`]: widthPoints,
        [`${prefix}HeightPoints`]: heightPoints,
    } as const;
}

export function decodePdfPageSizeRecord(
    page: unknown,
    pageCount: number,
    recordLabel: string,
) {
    if (!isRecord(page)) {
        throw new Error(`evb-pdf-page-ops returned no geometry for ${recordLabel}`);
    }
    const widthPoints = decodePdfPageSizeFinite(page.widthPoints)
        ?? (decodePdfPageSizeFinite(page.widthInches) === null ? null : decodePdfPageSizeFinite(page.widthInches)! * 72);
    const heightPoints = decodePdfPageSizeFinite(page.heightPoints)
        ?? (decodePdfPageSizeFinite(page.heightInches) === null ? null : decodePdfPageSizeFinite(page.heightInches)! * 72);
    const pageNumber = decodePdfPageSizeFinite(page.pageNumber);
    if (
        pageNumber === null
        || !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || pageNumber > pageCount
    ) {
        throw invalidPdfPageNumbering(`invalid page number for ${recordLabel}`);
    }
    if (widthPoints === null || heightPoints === null || widthPoints <= 0 || heightPoints <= 0) {
        throw new Error(`evb-pdf-page-ops returned invalid geometry for page ${String(pageNumber)}`);
    }
    const rawUserUnit = page.userUnit;
    let userUnit: number | undefined;
    if (rawUserUnit !== undefined) {
        const decodedUserUnit = decodePdfPageSizeFinite(rawUserUnit);
        if (decodedUserUnit === null || decodedUserUnit <= 0) {
            throw new Error(`evb-pdf-page-ops returned invalid UserUnit for page ${String(pageNumber)}`);
        }
        userUnit = decodedUserUnit;
    }
    const dominantImageWidthPx = decodePdfPageSizeFinite(page.dominantImageWidthPx);
    const dominantImageHeightPx = decodePdfPageSizeFinite(page.dominantImageHeightPx);
    const dominantImageWidthPoints = decodePdfPageSizeFinite(page.dominantImageWidthPoints);
    const dominantImageHeightPoints = decodePdfPageSizeFinite(page.dominantImageHeightPoints);
    const hasDominantImage = dominantImageWidthPx !== null
        && dominantImageHeightPx !== null
        && dominantImageWidthPoints !== null
        && dominantImageHeightPoints !== null
        && Number.isSafeInteger(dominantImageWidthPx)
        && Number.isSafeInteger(dominantImageHeightPx)
        && dominantImageWidthPx > 0
        && dominantImageHeightPx > 0
        && dominantImageWidthPoints > 0
        && dominantImageHeightPoints > 0;
    const media = decodeOptionalPdfBox(page, 'media');
    const crop = decodeOptionalPdfBox(page, 'crop');
    const renderBox = page.renderBox === 'cropbox' || page.renderBox === 'mediabox'
        ? page.renderBox
        : undefined;
    return {
        pageNumber,
        xPoints: decodePdfPageSizeFinite(page.xPoints) ?? 0,
        yPoints: decodePdfPageSizeFinite(page.yPoints) ?? 0,
        widthPoints,
        heightPoints,
        rotation: decodePdfPageSizeFinite(page.rotation) ?? 0,
        ...(userUnit === undefined ? {} : {userUnit}),
        ...(media ?? {}),
        ...(crop ?? {}),
        ...(renderBox === undefined ? {} : {renderBox}),
        ...(hasDominantImage ? {
            dominantImageWidthPx,
            dominantImageHeightPx,
            dominantImageWidthPoints,
            dominantImageHeightPoints,
        } : {}),
    } satisfies IPdfPageSize;
}
