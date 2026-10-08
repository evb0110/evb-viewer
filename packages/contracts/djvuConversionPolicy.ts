export interface IDjvuConversionPageMetrics {
    width: number;
    height: number;
}

export interface IDjvuPdfConversionMetrics {
    pageCount: number;
    sourceDpi: number;
    pageSizes?: readonly IDjvuConversionPageMetrics[] | null;
}

export interface IDjvuPdfConversionPolicyDecision {
    subsample: number;
    recommendedSubsample: number;
    effectivePixels: number;
    isAllowed: boolean;
}

export type TDjvuPdfExportStrategy = 'direct' | 'compact-djvu-aware' | 'auto';

export type TDjvuPdfResolvedExportStrategy = 'direct' | 'compact-djvu-aware';

export type TDjvuCompactFidelityPreset = 'small' | 'balanced' | 'archival';

export function resolveDjvuCompactFidelityPreset(subsample: number | undefined): TDjvuCompactFidelityPreset {
    const normalized = normalizeDjvuPdfSubsample(subsample);
    if (normalized >= 4) {
        return 'small';
    }
    if (normalized >= 2) {
        return 'balanced';
    }
    return 'archival';
}

export const DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES = [
    1,
    2,
    4,
] as const;

export const DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT = 8_000_000_000;

const FALLBACK_BOOK_PAGE_AREA_SQUARE_INCHES = 8.5 * 11;
const DEFAULT_DJVU_SOURCE_DPI = 300;

function normalizePositiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

export function normalizeDjvuPdfSubsample(value: number | undefined) {
    return normalizePositiveInteger(value ?? 1, 1);
}

export function resolveDjvuPdfExportStrategy(
    strategy: TDjvuPdfExportStrategy | undefined,
): TDjvuPdfResolvedExportStrategy {
    switch (strategy ?? 'direct') {
        case 'auto':
        case 'direct':
            return 'direct';
        case 'compact-djvu-aware':
            return 'compact-djvu-aware';
    }
}

function estimateSourcePixels(metrics: IDjvuPdfConversionMetrics) {
    const pagePixels = (metrics.pageSizes ?? [])
        .filter(size => Number.isFinite(size.width) && size.width > 0 && Number.isFinite(size.height) && size.height > 0)
        .reduce((total, size) => total + (Math.trunc(size.width) * Math.trunc(size.height)), 0);
    if (pagePixels > 0) {
        return pagePixels;
    }

    const pageCount = normalizePositiveInteger(metrics.pageCount, 1);
    const dpi = normalizePositiveInteger(metrics.sourceDpi, DEFAULT_DJVU_SOURCE_DPI);
    return pageCount * dpi * dpi * FALLBACK_BOOK_PAGE_AREA_SQUARE_INCHES;
}

function estimateEffectivePixels(sourcePixels: number, subsample: number) {
    return Math.ceil(sourcePixels / (subsample * subsample));
}

/** The source-pixel aggregate of one metrics snapshot; every subsample decision derives from it. */
export interface IDjvuPdfConversionSourceEstimate {
    sourcePixels: number;
    recommendedSubsample: number;
}

export function estimateDjvuPdfConversionSource(metrics: IDjvuPdfConversionMetrics): IDjvuPdfConversionSourceEstimate {
    const sourcePixels = estimateSourcePixels(metrics);
    return {
        sourcePixels,
        recommendedSubsample: DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES.find(subsample =>
            estimateEffectivePixels(sourcePixels, subsample) <= DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
        ) ?? DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES.at(-1)!,
    };
}

export const BROWSER_DJVU_CONVERSION_MAX_PAGES = 500;
export const BROWSER_DJVU_CONVERSION_MAX_PAGE_PIXELS = 80_000_000;

export interface IBrowserDjvuPreflightPageSize {
    width?: number | undefined;
    height?: number | undefined;
}

export interface IBrowserDjvuConversionPreflight {
    allowed: boolean;
    maxPagePixels: number;
    maxPages: number;
    observedMaxPagePixels: number;
    pageCount: number;
    reason?: 'page-count' | 'page-pixels';
}

export function resolveBrowserDjvuConversionPreflight(
    pageSizes: readonly IBrowserDjvuPreflightPageSize[],
    pageCount = pageSizes.length,
): IBrowserDjvuConversionPreflight {
    const observedMaxPagePixels = pageSizes.reduce((maxPixels, page) => {
        const width = Number.isFinite(page.width) ? Math.max(0, Math.trunc(page.width ?? 0)) : 0;
        const height = Number.isFinite(page.height) ? Math.max(0, Math.trunc(page.height ?? 0)) : 0;
        return Math.max(maxPixels, width * height);
    }, 0);
    const observedPageCount = Math.max(
        pageSizes.length,
        Number.isFinite(pageCount) ? Math.trunc(pageCount) : 0,
    );
    const reason = observedPageCount > BROWSER_DJVU_CONVERSION_MAX_PAGES
        ? 'page-count'
        : observedMaxPagePixels > BROWSER_DJVU_CONVERSION_MAX_PAGE_PIXELS
            ? 'page-pixels'
            : undefined;
    return {
        allowed: reason === undefined,
        maxPagePixels: BROWSER_DJVU_CONVERSION_MAX_PAGE_PIXELS,
        maxPages: BROWSER_DJVU_CONVERSION_MAX_PAGES,
        observedMaxPagePixels,
        pageCount: observedPageCount,
        ...(reason ? {reason} : {}),
    };
}

export function evaluateDjvuPdfConversionPolicy(
    source: IDjvuPdfConversionSourceEstimate,
    subsample: number | undefined,
): IDjvuPdfConversionPolicyDecision {
    const normalizedSubsample = normalizeDjvuPdfSubsample(subsample);
    const effectivePixels = estimateEffectivePixels(source.sourcePixels, normalizedSubsample);

    return {
        subsample: normalizedSubsample,
        recommendedSubsample: source.recommendedSubsample,
        effectivePixels,
        isAllowed: normalizedSubsample >= source.recommendedSubsample
            || effectivePixels <= DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
    };
}
