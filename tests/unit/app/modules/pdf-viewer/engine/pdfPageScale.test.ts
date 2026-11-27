import {describe, expect, it} from 'vitest';
import {
    buildPdfPageScaleStyle,
    createPdfPageScale,
    PDF_PAGE_SCALE_CSS_VARS,
    toPdfScaledCssLength,
} from '@app/modules/pdf-viewer/engine/pdf-page-scale/pdfPageScale';

describe('pdfPageScale', () => {
    it('keeps scale factor and user unit independent when either input is unavailable', () => {
        expect(createPdfPageScale(2.5, undefined)).toEqual({
            scaleFactor: 2.5,
            userUnit: 1,
            totalScaleFactor: 2.5,
        });
        expect(createPdfPageScale(undefined, 3)).toEqual({
            scaleFactor: 1,
            userUnit: 3,
            totalScaleFactor: 3,
        });
    });

    it('builds the canonical page CSS scale variables', () => {
        expect(buildPdfPageScaleStyle(createPdfPageScale(2.5, 2))).toEqual({
            [PDF_PAGE_SCALE_CSS_VARS.scaleFactor]: '2.5',
            [PDF_PAGE_SCALE_CSS_VARS.userUnit]: '2',
            [PDF_PAGE_SCALE_CSS_VARS.totalScaleFactor]: 'calc(var(--scale-factor, 1) * var(--user-unit, 1))',
        });
    });

    it('builds live CSS lengths from PDF units with optional screen-space padding', () => {
        expect(toPdfScaledCssLength(2)).toBe('calc(var(--total-scale-factor, 1) * 2px)');
        expect(toPdfScaledCssLength(2, 14)).toBe('calc(var(--total-scale-factor, 1) * 2px + 14px)');
    });

    it('rejects non-finite CSS lengths', () => {
        expect(() => toPdfScaledCssLength(Number.NaN)).toThrow(TypeError);
        expect(() => toPdfScaledCssLength(1, Number.POSITIVE_INFINITY)).toThrow(TypeError);
    });
});
