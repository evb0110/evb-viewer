import {
    describe,
    expect,
    it,
} from 'vitest';
import { ZOOM } from '@app/constants/pdfLayout';
import {
    clampDocumentFitScale,
    clampDocumentManualZoom,
} from '@app/modules/document-viewer/zoomPolicy';

describe('document zoom policy', () => {
    it('applies the central manual bounds to every viewer', () => {
        expect(clampDocumentManualZoom(0)).toBe(ZOOM.MIN);
        expect(clampDocumentManualZoom(Number.POSITIVE_INFINITY)).toBe(1);
        expect(clampDocumentManualZoom(ZOOM.MAX * 2)).toBe(ZOOM.MAX);
    });

    it('uses the fit-specific minimum', () => {
        expect(clampDocumentFitScale(0)).toBe(ZOOM.FIT_MIN);
        expect(clampDocumentFitScale(ZOOM.MAX * 2)).toBe(ZOOM.MAX);
    });
});
