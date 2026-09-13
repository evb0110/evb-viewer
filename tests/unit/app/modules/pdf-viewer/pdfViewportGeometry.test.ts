import { requirePageNumber } from '@contracts/pageNumbers';
import {
    createPdfViewportGeometryFromLayout,
    computePdfViewportGeometry,
    getViewportGeometryRowForPage,
    resolveAnchorFromScroll,
    resolveRetainedAnchorFromScroll,
    resolveScrollForAnchor,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import {
    getLayoutContentHeight,
    getLayoutPhysicalScrollSegmentTransition,
    PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
} from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { getViewportVisibilityFromLayout } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import { normalizePageMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/normalizePageMetrics';
import type { IPdfPageMetric } from '@app/types/pdfUi';

describe('pdfViewportGeometry', () => {
    const pages = [
        {
            width: 600,
            height: 800,
        },
        {
            width: 800,
            height: 600,
        },
        {
            width: 600,
            height: 1_200,
        },
    ];

    it('retains a semantic resize anchor when narrow geometry clamps its projected scroll', () => {
        const wide = computePdfViewportGeometry({
            revision: 1,
            pages: [{
                width: 600,
                height: 800,
            }],
            viewportWidth: 900,
            viewportHeight: 600,
            zoom: 1.5,
            viewMode: 'single',
            gap: 20,
            padding: 20,
        });
        const intendedAnchor = resolveAnchorFromScroll(wide, {
            left: 0,
            top: 600,
        });
        const narrow = computePdfViewportGeometry({
            revision: 2,
            pages: [{
                width: 600,
                height: 800,
            }],
            viewportWidth: 360,
            viewportHeight: 600,
            zoom: 0.5,
            viewMode: 'single',
            gap: 20,
            padding: 20,
        });
        const clamped = resolveScrollForAnchor(narrow, intendedAnchor);

        expect(clamped.top).toBe(0);
        expect(resolveAnchorFromScroll(narrow, clamped).pageYFraction)
            .not.toBeCloseTo(intendedAnchor.pageYFraction, 3);
        expect(resolveRetainedAnchorFromScroll(narrow, clamped, intendedAnchor))
            .toEqual(intendedAnchor);
        expect(resolveScrollForAnchor(wide, resolveRetainedAnchorFromScroll(
            narrow,
            clamped,
            intendedAnchor,
        ))).toEqual(resolveScrollForAnchor(wide, intendedAnchor));
    });

    it('resolves the exact page and anchor inside the second physical segment', () => {
        const pageMetrics = Array.from({length: 20_000}, () => ({
            width: 600,
            height: 1_000,
        }));
        const layout = buildPageLayoutMetrics({
            pageMetrics,
            totalPages: pageMetrics.length,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected segmented page layout');
        }

        const visibility = getViewportVisibilityFromLayout(
            {
                clientHeight: 1_000,
                clientWidth: 1_000,
                scrollTop: 10_200_020 - PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
                scrollLeft: 0,
            } as HTMLElement,
            pageMetrics.length,
            layout,
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
        );

        expect(visibility).toEqual({
            range: {
                start: 10_001,
                end: 10_001,
            },
            mostVisiblePage: 10_001,
        });
    });

    it('crosses a physical segment boundary once in either direction', () => {
        const pageMetrics = Array.from({length: 20_000}, () => ({
            width: 600,
            height: 1_000,
        }));
        const layout = buildPageLayoutMetrics({
            pageMetrics,
            totalPages: pageMetrics.length,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected segmented page layout');
        }

        const viewportHeight = 1_000;
        const firstSegmentBottom = PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT - viewportHeight;
        const forward = getLayoutPhysicalScrollSegmentTransition(
            layout,
            firstSegmentBottom,
            firstSegmentBottom - 100,
            viewportHeight,
            0,
        );
        expect(forward).toEqual({
            origin: PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
            page: 8_226,
            scrollTop: 912,
        });

        const backward = getLayoutPhysicalScrollSegmentTransition(
            layout,
            0,
            100,
            viewportHeight,
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
        );
        expect(backward).toEqual({
            origin: 0,
            page: 8_224,
            scrollTop: firstSegmentBottom,
        });
    });

    it('is pure and preserves a semantic anchor across corrected geometry', () => {
        const before = computePdfViewportGeometry({
            revision: 1,
            pages,
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 10,
            padding: 20,
        });
        const anchor = resolveAnchorFromScroll(before, {
            left: 0,
            top: 840,
        });
        const corrected = computePdfViewportGeometry({
            revision: 2,
            pages: [
                {
                    width: 600,
                    height: 840,
                },
                ...pages.slice(1),
            ],
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 10,
            padding: 20,
        });

        expect(anchor.page).toBe(2);
        expect(resolveScrollForAnchor(corrected, anchor).top).toBeGreaterThan(840);
        expect(anchor).toEqual(resolveAnchorFromScroll(before, {
            left: 0,
            top: 840,
        }));
    });

    it('builds facing rows atomically and keeps DPR outside CSS geometry', () => {
        const geometry = computePdfViewportGeometry({
            revision: 3,
            pages,
            viewportWidth: 1_400,
            viewportHeight: 800,
            zoom: 1,
            viewMode: 'facing-first-single',
            gap: 12,
            padding: 16,
        });
        expect(geometry.rows.map(row => [
            row.startPage,
            row.endPage,
        ])).toEqual([
            [
                1,
                1,
            ],
            [
                2,
                3,
            ],
        ]);
        expect(geometry.pageRects).toHaveLength(3);
        const rightPage = geometry.pageRects[2]!;
        const rightPageAnchor = resolveAnchorFromScroll(geometry, {
            left: Math.max(0, rightPage.left + rightPage.width / 2 - geometry.viewportWidth / 2),
            top: rightPage.top,
        });
        expect(rightPageAnchor.page).toBe(3);
    });

    it('keeps both outer edges of a narrow mixed-width facing spread in the analytical scroll domain', () => {
        const geometry = computePdfViewportGeometry({
            revision: 4,
            pages: [
                {
                    width: 700,
                    height: 900,
                },
                {
                    width: 500,
                    height: 800,
                },
            ],
            viewportWidth: 430,
            viewportHeight: 700,
            zoom: 1.29,
            viewMode: 'facing',
            gap: 20,
            padding: 20,
        });
        const leftPage = geometry.pageRects[0]!;
        const rightPage = geometry.pageRects[1]!;
        const maxScrollLeft = geometry.contentWidth - geometry.viewportWidth;

        expect(leftPage.left).toBe(20);
        expect(rightPage.left).toBe(leftPage.left + leftPage.width + 20);
        expect(geometry.contentWidth).toBe(700 * 1.29 + 20 + 500 * 1.29 + 40);
        expect(leftPage.left).toBeGreaterThanOrEqual(0);
        expect(rightPage.left + rightPage.width - maxScrollLeft).toBe(410);
    });

    it('keeps fit-height spread geometry identical to the physical page-track padding and gap', () => {
        const viewport = {
            width: 1_200,
            height: 900,
        };
        const margin = 20;
        const pageHeight = 800;
        const scale = (viewport.height - margin * 2) / pageHeight;
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 400,
                    height: pageHeight,
                },
                {
                    width: 400,
                    height: pageHeight,
                },
            ],
            totalPages: 2,
            viewMode: 'facing',
            scale,
            gap: margin,
            paddingTop: margin,
            paddingBottom: margin,
        });
        if (!layout) {
            throw new Error('Expected fit-height page layout');
        }

        const geometry = createPdfViewportGeometryFromLayout(layout, viewport, 1);
        const [
            leftPage,
            rightPage,
        ] = geometry.pageRects;
        expect(getLayoutContentHeight(layout)).toBe(viewport.height);
        expect(leftPage?.top).toBe(margin);
        expect(leftPage?.height).toBe(viewport.height - margin * 2);
        expect((rightPage?.left ?? 0) - ((leftPage?.left ?? 0) + (leftPage?.width ?? 0))).toBe(margin);
        expect(geometry.rows[0]?.rect.width).toBe(
            (leftPage?.width ?? 0) + margin + (rightPage?.width ?? 0),
        );
    });

    it('keeps million-page viewport geometry indexed and avoids whole-document iteration', () => {
        const totalPages = 1_000_000;
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 500,
        };
        sparseMetrics[totalPages - 1] = {
            width: 320,
            height: 520,
        };
        const iteratorSpy = vi.spyOn(sparseMetrics, Symbol.iterator).mockImplementation(() => {
            throw new Error('million-page metrics must not be iterated');
        });
        const normalized = normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages,
            fallbackWidth: 300,
            fallbackHeight: 500,
        });
        const normalizedIteratorSpy = vi.spyOn(normalized, Symbol.iterator).mockImplementation(() => {
            throw new Error('sparse normalized metrics must not be iterated');
        });
        const arrayFromSpy = vi.spyOn(Array, 'from').mockImplementation(() => {
            throw new Error('million-page geometry must not call Array.from');
        });

        try {
            const layout = buildPageLayoutMetrics({
                pageMetrics: normalized,
                pageMetricsVersion: 1,
                totalPages,
                viewMode: 'facing',
                scale: 1,
                gap: 12,
                paddingTop: 8,
                paddingBottom: 8,
            });
            if (!layout) {
                throw new Error('Expected million-page layout');
            }

            const geometry = createPdfViewportGeometryFromLayout(layout, {
                width: 900,
                height: 700,
            }, 1);
            expect(geometry.pageRects.length).toBe(totalPages);
            expect(geometry.rows.length).toBe(500_000);
            expect(Object.keys(geometry.pageRects).filter(key => /^\d+$/.test(key))).toHaveLength(0);
            expect(Object.keys(geometry.rows).filter(key => /^\d+$/.test(key))).toHaveLength(0);

            const firstPage = geometry.pageRects[0]!;
            const lastPage = geometry.pageRects[totalPages - 1]!;
            expect(firstPage.width).toBe(300);
            expect(firstPage.height).toBe(500);
            expect(lastPage.width).toBe(320);
            expect(lastPage.height).toBe(520);
            expect(getViewportGeometryRowForPage(geometry, requirePageNumber(totalPages))).toMatchObject({
                startPage: totalPages - 1,
                endPage: totalPages,
            });

            const lastPageAnchor = resolveAnchorFromScroll(geometry, {
                left: lastPage.left + lastPage.width / 2 - 450,
                top: lastPage.top + 100,
            });
            expect(lastPageAnchor.page).toBe(totalPages);
        } finally {
            arrayFromSpy.mockRestore();
            normalizedIteratorSpy.mockRestore();
            iteratorSpy.mockRestore();
        }
    });

    it('keeps a page-top anchor above the declared content inset', () => {
        const geometry = computePdfViewportGeometry({
            revision: 1,
            pages,
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 20,
            padding: 20,
        });

        expect(resolveScrollForAnchor(geometry, {
            page: 1,
            pageXFraction: 0.5,
            pageYFraction: 0,
            viewportXFraction: 0.5,
            viewportYFraction: 0,
            affinity: 'start',
        }).top).toBe(0);
        expect(resolveScrollForAnchor(geometry, {
            page: 2,
            pageXFraction: 0.5,
            pageYFraction: 0,
            viewportXFraction: 0.5,
            viewportYFraction: 0,
            affinity: 'start',
        }).top).toBe(820);
    });
});
