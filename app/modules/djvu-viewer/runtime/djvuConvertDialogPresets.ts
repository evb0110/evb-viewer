import {
    normalizeDjvuPdfSubsample,
    type IDjvuPdfConversionSourceEstimate,
    type TDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';

export const DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE = 'compact-djvu-aware' as const;
export const DJVU_COMPACT_BALANCED_PRESET_VALUE = 'compact-balanced' as const;
export const DJVU_COMPACT_SMALL_PRESET_VALUE = 'compact-small' as const;
export const DJVU_COMPACT_ARCHIVAL_PRESET_VALUE = 'compact-archival' as const;

export type TDjvuConvertDialogDirectPresetValue = `direct-${number}`;
export type TDjvuConvertDialogPresetValue =
    | TDjvuConvertDialogDirectPresetValue
    | typeof DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE
    | typeof DJVU_COMPACT_BALANCED_PRESET_VALUE
    | typeof DJVU_COMPACT_SMALL_PRESET_VALUE
    | typeof DJVU_COMPACT_ARCHIVAL_PRESET_VALUE;
export type TDjvuConvertDialogPdfStrategy = Exclude<TDjvuPdfExportStrategy, 'auto'>;

export interface IDjvuConvertDialogSelection {
    subsample: number;
    pdfStrategy: TDjvuConvertDialogPdfStrategy;
}

function normalizePositiveInteger(value: number, fallback: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : fallback;
}

export function createDirectDjvuConvertDialogPresetValue(
    subsample: number,
): TDjvuConvertDialogDirectPresetValue {
    return `direct-${normalizeDjvuPdfSubsample(subsample)}`;
}

export function resolveDjvuConvertDialogSelection(
    value: TDjvuConvertDialogPresetValue,
    fallbackSubsample = 1,
): IDjvuConvertDialogSelection {
    if (value === DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE
        || value === DJVU_COMPACT_SMALL_PRESET_VALUE
        || value === DJVU_COMPACT_BALANCED_PRESET_VALUE
        || value === DJVU_COMPACT_ARCHIVAL_PRESET_VALUE) {
        return {
            subsample: value === DJVU_COMPACT_SMALL_PRESET_VALUE
                ? 4
                : value === DJVU_COMPACT_BALANCED_PRESET_VALUE ? 2 : 1,
            pdfStrategy: 'compact-djvu-aware',
        };
    }

    const rawSubsample = Number(value.replace(/^direct-/, ''));
    return {
        subsample: normalizeDjvuPdfSubsample(Number.isFinite(rawSubsample) ? rawSubsample : fallbackSubsample),
        pdfStrategy: 'direct',
    };
}

function resolvePageCountDefaultDjvuPdfSubsample(pageCount: number) {
    const normalizedPageCount = normalizePositiveInteger(pageCount, 1);
    if (normalizedPageCount >= 700) {
        return 4;
    }

    if (normalizedPageCount >= 250) {
        return 2;
    }

    return 1;
}

export function resolveRecommendedAdvancedDirectPresetValue(
    pageCount: number,
    source: IDjvuPdfConversionSourceEstimate,
): TDjvuConvertDialogDirectPresetValue {
    return createDirectDjvuConvertDialogPresetValue(Math.max(
        resolvePageCountDefaultDjvuPdfSubsample(pageCount),
        source.recommendedSubsample,
    ));
}
