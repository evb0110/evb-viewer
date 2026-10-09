import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    estimateDjvuPdfConversionSource,
    type IDjvuPdfConversionMetrics,
} from '@contracts/djvuConversionPolicy';
import {
    DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE,
    createDirectDjvuConvertDialogPresetValue,
    resolveDjvuConvertDialogSelection,
    resolveRecommendedAdvancedDirectPresetValue,
} from '@app/modules/djvu-viewer/runtime/djvuConvertDialogPresets';

function recommendAdvancedDirectPreset(metrics: IDjvuPdfConversionMetrics) {
    return resolveRecommendedAdvancedDirectPresetValue(metrics.pageCount, estimateDjvuPdfConversionSource(metrics));
}

describe('djvuConvertDialogPresets', () => {
    it('recommends full-resolution raster output for small simple DjVu documents in advanced options', () => {
        expect(recommendAdvancedDirectPreset({
            pageCount: 24,
            sourceDpi: 300,
        })).toBe('direct-1');
    });

    it('recommends safer raster subsampling for medium book scans in advanced options', () => {
        expect(recommendAdvancedDirectPreset({
            pageCount: 300,
            sourceDpi: 300,
        })).toBe('direct-2');
    });

    it('recommends compact raster output for very large book scans in advanced options', () => {
        expect(recommendAdvancedDirectPreset({
            pageCount: 800,
            sourceDpi: 300,
        })).toBe('direct-4');
        expect(recommendAdvancedDirectPreset({
            pageCount: 500,
            sourceDpi: 600,
        })).toBe('direct-2');
    });

    it('uses real page dimensions to recommend an allowed raster fallback', () => {
        const oversizedPageSizes = Array.from({ length: 564 }, () => ({
            width: 5100,
            height: 6600,
        }));

        expect(recommendAdvancedDirectPreset({
            pageCount: 564,
            sourceDpi: 300,
            pageSizes: oversizedPageSizes,
        })).toBe('direct-2');
    });

    it('decodes direct and compact preset selections for conversion', () => {
        expect(resolveDjvuConvertDialogSelection(createDirectDjvuConvertDialogPresetValue(4)))
            .toEqual({
                subsample: 4,
                pdfStrategy: 'direct',
            });
        expect(resolveDjvuConvertDialogSelection(DJVU_COMPACT_DJVU_AWARE_PRESET_VALUE))
            .toEqual({
                subsample: 1,
                pdfStrategy: 'compact-djvu-aware',
            });
    });
});
