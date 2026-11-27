import {describe, expect, it} from 'vitest';
import {ZOOM} from '@app/constants/pdfLayout';
import {clampPdfFitScale, clampPdfManualZoom, resolvePdfZoomScale} from '@app/modules/pdf-viewer/runtime/zoom/resolvePdfZoomScale';

describe('resolvePdfZoomScale', () => {
    it('clamps finite manual zoom values before the allowed range to the minimum', () => {
        expect(clampPdfManualZoom(0)).toBe(ZOOM.MIN);
        expect(clampPdfManualZoom(-1)).toBe(ZOOM.MIN);
        expect(clampPdfManualZoom(ZOOM.MIN / 2)).toBe(ZOOM.MIN);
    });

    it('uses the manual fallback only for non-finite zoom values', () => {
        expect(clampPdfManualZoom(Number.NaN)).toBe(1);
        expect(clampPdfManualZoom(Number.POSITIVE_INFINITY)).toBe(1);
        expect(clampPdfManualZoom(Number.NEGATIVE_INFINITY)).toBe(1);
    });

    it('clamps finite fit scale values before the fit range to the fit minimum', () => {
        expect(clampPdfFitScale(0)).toBe(ZOOM.FIT_MIN);
        expect(clampPdfFitScale(-1)).toBe(ZOOM.FIT_MIN);
        expect(clampPdfFitScale(ZOOM.FIT_MIN / 2)).toBe(ZOOM.FIT_MIN);
    });

    it('clamps values above the allowed zoom range to the maximum', () => {
        expect(clampPdfManualZoom(ZOOM.MAX * 2)).toBe(ZOOM.MAX);
        expect(clampPdfFitScale(ZOOM.MAX * 2)).toBe(ZOOM.MAX);
    });

    it('applies the same manual clamp through the zoom resolver', () => {
        expect(
            resolvePdfZoomScale({
                zoomMode: 'custom',
                fitMode: 'width',
                manualZoom: 0,
                fitScale: 1,
            }),
        ).toEqual({
            mode: 'custom',
            fitMode: 'width',
            effectiveScale: ZOOM.MIN,
        });
    });
});
