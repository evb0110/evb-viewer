import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveDocumentPageSourceRenderDemand } from '@app/modules/document-viewer/page-source-renderer/resolveDocumentPageSourceRenderDemand';

describe('resolveDocumentPageSourceRenderDemand', () => {
    const pageTops = [
        20,
        1040,
        2060,
        3080,
        4100,
        5120,
    ];
    const pageHeights = Array.from({length: pageTops.length}, () => 1000);

    it('keeps the broad geometry window out of raster residency', () => {
        expect(resolveDocumentPageSourceRenderDemand({
            continuousScroll: true,
            currentPage: 3,
            pageCount: pageTops.length,
            pageHeights,
            pageTops,
            scrollTop: 2500,
            viewportHeight: 900,
        })).toEqual({
            visiblePages: [
                3,
                4,
            ],
            bufferPages: [
                2,
                5,
            ],
            residentPages: [
                2,
                3,
                4,
                5,
            ],
        });
    });

    it('retains a navigation destination during the authoritative scroll handoff', () => {
        expect(resolveDocumentPageSourceRenderDemand({
            continuousScroll: true,
            currentPage: 6,
            pageCount: pageTops.length,
            pageHeights,
            pageTops,
            scrollTop: 0,
            viewportHeight: 800,
        })).toEqual({
            visiblePages: [
                1,
                6,
            ],
            bufferPages: [
                2,
                5,
            ],
            residentPages: [
                1,
                2,
                5,
                6,
            ],
        });
    });

    it('uses only the current page and its guard band in paged mode', () => {
        expect(resolveDocumentPageSourceRenderDemand({
            continuousScroll: false,
            currentPage: 4,
            pageCount: pageTops.length,
            pageHeights,
            pageTops,
            scrollTop: 0,
            viewportHeight: 800,
        })).toEqual({
            visiblePages: [4],
            bufferPages: [
                3,
                5,
            ],
            residentPages: [
                3,
                4,
                5,
            ],
        });
    });

    it('uses the shared pixel budget to keep an affordable wider guard band', () => {
        expect(resolveDocumentPageSourceRenderDemand({
            bufferRadius: 2,
            continuousScroll: true,
            currentPage: 3,
            estimatePagePixels: () => 10,
            maxBufferPixels: 40,
            mountedPages: [
                1,
                2,
                3,
                4,
                5,
                6,
            ],
            pageCount: pageTops.length,
            pageHeights,
            pageTops,
            scrollTop: 2500,
            viewportHeight: 900,
        })).toEqual({
            visiblePages: [
                3,
                4,
            ],
            bufferPages: [
                1,
                2,
                5,
                6,
            ],
            residentPages: [
                1,
                2,
                3,
                4,
                5,
                6,
            ],
        });
    });
});
