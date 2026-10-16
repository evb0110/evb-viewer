import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
    resolveDocumentVisiblePageForIndicator,
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

    it('names a visible page for the indicator, never a nearer page wholly offscreen', () => {
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 16,
            pageHeights: [
                10_000,
                100,
            ],
            totalPages: 2,
        });

        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 2,
            pageLayouts: geometry.pageTops.map((top, index) => ({
                top,
                height: geometry.pageHeights[index]!,
                width: 100,
            })),
            scrollLeft: 0,
            viewportWidth: 500,
            scrollTop: 9_000,
            totalPages: 2,
            viewportHeight: 500,
        })).toBe(1);
    });

    it('keeps the current page while it stays fully visible', () => {
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 0,
            pageHeights: [
                100,
                100,
                100,
            ],
            totalPages: 3,
        });

        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 3,
            pageLayouts: geometry.pageTops.map((top, index) => ({
                top,
                height: geometry.pageHeights[index]!,
                width: 100,
            })),
            scrollLeft: 0,
            viewportWidth: 500,
            scrollTop: 100,
            totalPages: 3,
            viewportHeight: 200,
        })).toBe(3);
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 1,
            pageLayouts: geometry.pageTops.map((top, index) => ({
                top,
                height: geometry.pageHeights[index]!,
                width: 100,
            })),
            scrollLeft: 0,
            viewportWidth: 500,
            scrollTop: 100,
            totalPages: 3,
            viewportHeight: 200,
        })).toBe(2);
    });

    it('chooses the greatest visible fraction and keeps the lower page on a tie', () => {
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 10,
            pageHeights: [
                1_000,
                100,
                100,
            ],
            totalPages: 3,
        });

        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 1,
            pageLayouts: geometry.pageTops.map((top, index) => ({
                top,
                height: geometry.pageHeights[index]!,
                width: 100,
            })),
            scrollLeft: 0,
            viewportWidth: 500,
            scrollTop: 900,
            totalPages: 3,
            viewportHeight: 300,
        })).toBe(2);
    });
    it('does not retain a page outside the horizontal viewport', () => {
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 1,
            pageLayouts: [
                {
                    left: 200,
                    top: 20,
                    height: 100,
                    width: 100,
                },
                {
                    left: 20,
                    top: 140,
                    height: 100,
                    width: 1000,
                },
            ],
            scrollTop: 0,
            scrollLeft: 400,
            viewportHeight: 500,
            viewportWidth: 500,
            totalPages: 2,
        })).toBe(2);
    });

    it('ranks complete visible-area fractions across a spread', () => {
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 1,
            pageLayouts: [
                {
                    left: 0,
                    top: 20,
                    height: 100,
                    width: 1000,
                },
                {
                    left: 1020,
                    top: 20,
                    height: 100,
                    width: 100,
                },
            ],
            scrollTop: 0,
            scrollLeft: 900,
            viewportHeight: 500,
            viewportWidth: 150,
            totalPages: 2,
        })).toBe(2);
    });

    it('retains a fully visible spread page and includes its taller facing page', () => {
        const pageLayouts = [
            {
                left: 0,
                top: 20,
                height: 400,
                width: 100,
            },
            {
                left: 120,
                top: 20,
                height: 100,
                width: 100,
            },
        ];
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 2,
            pageLayouts,
            scrollTop: 0,
            scrollLeft: 0,
            viewportHeight: 500,
            viewportWidth: 500,
            totalPages: 2,
        })).toBe(2);
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 2,
            pageLayouts,
            scrollTop: 150,
            scrollLeft: 0,
            viewportHeight: 100,
            viewportWidth: 500,
            totalPages: 2,
        })).toBe(1);
    });

    it('names an intersecting page even when no page meets the height threshold', () => {
        expect(resolveDocumentVisiblePageForIndicator({
            currentPage: 1,
            pageLayouts: [
                {
                    top: 16,
                    height: 100,
                    width: 100,
                },
                {
                    top: 132,
                    height: 100,
                    width: 100,
                },
            ],
            scrollTop: 113,
            scrollLeft: 0,
            viewportHeight: 20,
            viewportWidth: 500,
            totalPages: 2,
        })).toBe(1);
    });

    it('keeps the lower page on an area tie and returns null for a gap with no pixels', () => {
        const pageLayouts = [
            {
                top: 0,
                left: 0,
                height: 100,
                width: 100,
            },
            {
                top: 0,
                left: 120,
                height: 100,
                width: 100,
            },
        ];
        const viewport = {
            pageLayouts,
            scrollTop: 50,
            scrollLeft: 0,
            viewportHeight: 20,
            viewportWidth: 500,
            totalPages: 2,
        };
        expect(resolveDocumentVisiblePageForIndicator({
            ...viewport,
            currentPage: 2,
        })).toBe(1);
        expect(resolveDocumentVisiblePageForIndicator({
            ...viewport,
            currentPage: 2,
            scrollTop: 110,
        })).toBeNull();
    });
});
