import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentPageSourceOpeningFrame } from '@app/modules/document-viewer/public';

const geometry = {
    documentId: '/documents/scan.djvu',
    pageNumber: 1,
    pageCount: 100,
    width: 1200,
    height: 1600,
    rotation: 0,
} as const;

describe('resolveDocumentPageSourceOpeningFrame', () => {
    it('derives the exact fit-width shell from the live chassis viewport', () => {
        const frame = resolveDocumentPageSourceOpeningFrame({
            geometry,
            viewportWidth: 900,
            viewportHeight: 537,
            zoom: 1,
            zoomMode: 'fit-width',
        });
        expect(frame?.width).toBeCloseTo(860);
        expect(frame?.height).toBeCloseTo(1146.6666666666667);
        expect(Number.parseFloat(frame?.style.width ?? '')).toBeCloseTo(860);
        expect(Number.parseFloat(frame?.style.height ?? '')).toBeCloseTo(1146.6666666666667);
    });

    it('uses the live viewport height for fit-height and the zoom policy for custom scale', () => {
        expect(resolveDocumentPageSourceOpeningFrame({
            geometry,
            viewportWidth: 900,
            viewportHeight: 832,
            zoom: 1,
            zoomMode: 'fit-height',
        })?.height).toBe(792);
        expect(resolveDocumentPageSourceOpeningFrame({
            geometry,
            viewportWidth: 900,
            viewportHeight: 832,
            zoom: 1.25,
            zoomMode: 'custom',
        })?.width).toBe(1500);
    });

    it('refuses to claim a frame without a usable live viewport', () => {
        expect(resolveDocumentPageSourceOpeningFrame({
            geometry,
            viewportWidth: 0,
            viewportHeight: 537,
            zoom: 1,
            zoomMode: 'fit-width',
        })).toBeNull();
    });
});
