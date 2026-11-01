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

/**
 * Per-preset fidelity of a compact DjVu export, shared by desktop and the
 * browser: JPEG quality of layered backgrounds and of photo pages, and the
 * resolution photo pages are reduced to.
 */
export const DJVU_COMPACT_FIDELITY = {
    small: {
        backgroundQuality: 70,
        photoQuality: 75,
        ppiCap: 180,
    },
    balanced: {
        backgroundQuality: 80,
        photoQuality: 85,
        ppiCap: 300,
    },
    archival: {
        backgroundQuality: 95,
        photoQuality: 95,
        ppiCap: 1200,
    },
} as const satisfies Record<TDjvuCompactFidelityPreset, {
    backgroundQuality: number;
    photoQuality: number;
    ppiCap: number
}>;

export function getDjvuCompactFidelity(preset: TDjvuCompactFidelityPreset | undefined) {
    return DJVU_COMPACT_FIDELITY[preset ?? 'balanced'];
}

/** A JB2 mask chunk smaller than this carries no real foreground. */
export const DJVU_COMPACT_REAL_MASK_MIN_BYTES = 128;
/** Sampling step of the foreground layer when it has no resolution of its own. */
export const DJVU_COMPACT_FOREGROUND_SUBSAMPLE = 12;

/** Pixel statistics of a rendered layer, as both runtimes measure them. */
export interface IDjvuCompactRasterStats {
    nonWhiteRatio: number;
    darkRatio: number;
    colorRatio: number;
    minChannel: number;
    maxChannel: number;
}

export interface IDjvuCompactForegroundColor {
    dominantColor: [number, number, number];
    colorRatio: number;
}

const BACKGROUND_FLAT_NON_WHITE_RATIO = 0.002;
const BACKGROUND_FLAT_MIN_CHANNEL = 220;
const BACKGROUND_FLAT_CHANNEL_RANGE = 20;
const BACKGROUND_FLAT_COLOR_RATIO = 0.02;
const FOREGROUND_COLOR_RATIO_MIN = 0.05;
const FOREGROUND_COLOR_SATURATION_MIN = 24;
const FOREGROUND_NEAR_BLACK_MAX = 80;
/** Foreground pixels this light or lighter do not count toward its dominant color. */
export const DJVU_COMPACT_FOREGROUND_DOMINANT_NON_WHITE_MAX = 230;

/** A background with nothing to keep: the page is its mask alone. */
export function isDjvuCompactFlatBackground(stats: IDjvuCompactRasterStats) {
    if (stats.nonWhiteRatio <= BACKGROUND_FLAT_NON_WHITE_RATIO) {
        return true;
    }

    const colorTotalRatio = stats.colorRatio * stats.nonWhiteRatio;
    return stats.darkRatio === 0
        && stats.minChannel >= BACKGROUND_FLAT_MIN_CHANNEL
        && stats.maxChannel - stats.minChannel <= BACKGROUND_FLAT_CHANNEL_RANGE
        && colorTotalRatio <= BACKGROUND_FLAT_COLOR_RATIO;
}

/** A colored foreground a black mask would lose: the page is kept as a photo. */
export function hasDjvuCompactForegroundColor(analysis: IDjvuCompactForegroundColor) {
    const spread = Math.max(...analysis.dominantColor) - Math.min(...analysis.dominantColor);
    const maxChannel = Math.max(...analysis.dominantColor);
    return analysis.colorRatio > FOREGROUND_COLOR_RATIO_MIN
        && spread > FOREGROUND_COLOR_SATURATION_MIN
        && maxChannel >= FOREGROUND_NEAR_BLACK_MAX;
}

/**
 * Measures interleaved 8-bit pixels (1, 3 or 4 channels; alpha is ignored),
 * with the white, dark and color tests the compact routes use.
 */
export function measureDjvuCompactRasterStats(
    pixels: ArrayLike<number>,
    width: number,
    height: number,
    channels: 1 | 3 | 4,
): IDjvuCompactRasterStats & {maxDarkRunRatio: number} {
    const totalPixels = width * height;
    let nonWhitePixels = 0;
    let darkPixels = 0;
    let colorPixels = 0;
    let maxDarkRun = 0;
    let minChannel = 255;
    let maxChannel = 0;
    for (let y = 0; y < height; y += 1) {
        let darkRun = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * channels;
            const red = pixels[offset] ?? 255;
            const green = channels === 1 ? red : pixels[offset + 1] ?? 255;
            const blue = channels === 1 ? red : pixels[offset + 2] ?? 255;
            const min = Math.min(red, green, blue);
            const max = Math.max(red, green, blue);
            minChannel = Math.min(minChannel, min);
            maxChannel = Math.max(maxChannel, max);
            if (red < 245 || green < 245 || blue < 245) {
                nonWhitePixels += 1;
                if (channels !== 1 && max - min > 12) {
                    colorPixels += 1;
                }
            }
            if (red < 80 && green < 80 && blue < 80) {
                darkPixels += 1;
                darkRun += 1;
                maxDarkRun = Math.max(maxDarkRun, darkRun);
            } else {
                darkRun = 0;
            }
        }
    }
    return {
        nonWhiteRatio: nonWhitePixels / Math.max(1, totalPixels),
        darkRatio: darkPixels / Math.max(1, totalPixels),
        colorRatio: colorPixels / Math.max(1, nonWhitePixels),
        maxDarkRunRatio: maxDarkRun / Math.max(1, width),
        minChannel,
        maxChannel,
    };
}
