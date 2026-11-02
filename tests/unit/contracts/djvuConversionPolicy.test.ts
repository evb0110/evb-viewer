import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    estimateDjvuPdfConversionSource,
    evaluateDjvuPdfConversionPolicy,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';

describe('djvuConversionPolicy', () => {
    it('blocks full-quality direct PDF export for high-DPI book scans', () => {
        const metrics = {
            pageCount: 564,
            sourceDpi: 600,
            pageSizes: Array.from({length: 564}, () => ({
                width: 5100,
                height: 6600,
            })),
        };

        const source = estimateDjvuPdfConversionSource(metrics);
        expect(Math.round(evaluateDjvuPdfConversionPolicy(source, 1).effectivePixels / 1_000_000_000)).toBe(19);
        expect(source.recommendedSubsample).toBe(2);
        expect(evaluateDjvuPdfConversionPolicy(source, 1)).toMatchObject({
            recommendedSubsample: 2,
            isAllowed: false,
        });
        expect(evaluateDjvuPdfConversionPolicy(source, 2)).toMatchObject({
            recommendedSubsample: 2,
            isAllowed: true,
        });
    });

    it('falls back to page count and DPI when page sizes are unavailable', () => {
        const metrics = {
            pageCount: 10,
            sourceDpi: 300,
        };

        const source = estimateDjvuPdfConversionSource(metrics);
        expect(source.recommendedSubsample).toBe(1);
        expect(evaluateDjvuPdfConversionPolicy(source, 1).isAllowed).toBe(true);
    });

    it('resolves Stage A PDF export strategies without changing default direct conversion', () => {
        expect(resolveDjvuPdfExportStrategy(undefined)).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('direct')).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('auto')).toBe('direct');
        expect(resolveDjvuPdfExportStrategy('compact-djvu-aware')).toBe('compact-djvu-aware');
    });
});
