import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
    resolveNearestDocumentPageToViewportCenter,
} from '@app/modules/document-viewer/viewport/resolveDocumentContinuousScrollWindow';

describe('resolveDocumentContinuousScrollWindow', () => {
    const pageHeights = Array.from({ length: 12 }, () => 100);

    it('creates stable page offsets and full document height', () => {
        expect(resolveDocumentContinuousScrollGeometry({
            pageGapPx: 10,
            pageHeights: [
                100,
                120,
                80,
            ],
            totalPages: 3,
        })).toEqual({
            pageHeights: [
                100,
                120,
                80,
            ],
            pageTops: [
                10,
                120,
                250,
            ],
            totalHeight: 340,
        });
    });

    it('returns an anchored fallback window when the viewport has no height', () => {
        expect(resolveDocumentContinuousScrollWindow({
            currentPage: 10,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 3,
            scrollTop: 0,
            totalPages: 12,
            viewportHeight: 0,
            overscanViewports: 2,
        })).toEqual({
            start: 7,
            end: 12,
            mostVisiblePage: 10,
            pageNumbers: [
                7,
                8,
                9,
                10,
                11,
                12,
            ],
        });
    });

    it('resolves the visible page and render margin from page geometry', () => {
        expect(resolveDocumentContinuousScrollWindow({
            currentPage: 5,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 1,
            scrollTop: 125,
            totalPages: 12,
            viewportHeight: 100,
            overscanViewports: 1,
        })).toEqual({
            start: 1,
            end: 3,
            mostVisiblePage: 2,
            pageNumbers: [
                1,
                2,
                3,
            ],
        });
    });

    it('uses the overscan range when the viewport is between pages', () => {
        expect(resolveDocumentContinuousScrollWindow({
            currentPage: 5,
            pageGapPx: 10,
            pageHeights,
            renderMarginPages: 1,
            scrollTop: 0,
            totalPages: 12,
            viewportHeight: 5,
            overscanViewports: 2,
        })).toEqual({
            start: 1,
            end: 2,
            mostVisiblePage: 1,
            pageNumbers: [
                1,
                2,
            ],
        });
    });

    it('finds the nearest page center without scanning all pages', () => {
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 10,
            pageHeights: [
                1_000,
                100,
                100,
            ],
            totalPages: 3,
        });

        expect(resolveNearestDocumentPageToViewportCenter({
            geometry,
            scrollTop: 900,
            totalPages: 3,
            viewportHeight: 300,
        })).toBe(2);
    });
});
