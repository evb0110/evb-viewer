import { requirePageNumber } from '@contracts/pageNumbers';
import {
    createPdfViewportGeometryFromLayout,
    computePdfViewportGeometry,
    getViewportGeometryRowForPage,
    resolveAnchorFromScroll,
    resolvePageIndicatorFromScroll,
    resolveRetainedAnchorFromScroll,
    resolveScrollForAnchor,
    buildPageLayoutMetrics,
    getLayoutContentHeight,
    getLayoutPhysicalScrollSegment,
    getLayoutRowHeight,
    getLayoutRowTop,
    resolveLayoutPhysicalScrollOrigin,
    PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
    normalizePageMetrics,
} from '@app/modules/document-viewer/public';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { getViewportVisibilityFromLayout } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import type { IPdfPageMetric } from '@app/types/pdfUi';

describe('pdfViewportGeometry', () => {
    it('projects R1 retention, qualifying fractions and facing ties independently of the center anchor', () => {
        const mixed = computePdfViewportGeometry({
            revision: 1,
            pages: [
                {
                    width: 400,
                    height: 200,
                },
                {
                    width: 400,
                    height: 1_000,
                },
            ],
            viewportWidth: 450,
            viewportHeight: 600,
            zoom: 1,
            viewMode: 'single',
            gap: 20,
            padding: 20,
        });
        expect(resolveAnchorFromScroll(mixed, {
            left: 0,
            top: 20,
        }).page).toBe(2);
        expect(resolvePageIndicatorFromScroll(mixed, {
            left: 0,
            top: 20,
        }, 1)).toBe(1);
        expect(resolvePageIndicatorFromScroll(mixed, {
            left: 0,
            top: 80,
        }, 1)).toBe(1);
        expect(resolvePageIndicatorFromScroll(mixed, {
            left: 0,
            top: 180,
        }, 1)).toBe(2);
        expect(resolvePageIndicatorFromScroll({
            ...mixed,
            physicalScrollOrigin: 240,
        }, {
            left: 0,
            top: 0,
        }, 1)).toBe(2);
        const spread = computePdfViewportGeometry({
            revision: 2,
            pages: [
                {
                    width: 200,
                    height: 800,
                },
                {
                    width: 200,
                    height: 800,
                },
            ],
            viewportWidth: 450,
            viewportHeight: 600,
            zoom: 1,
            viewMode: 'facing',
            gap: 20,
            padding: 20,
        });
        expect(resolvePageIndicatorFromScroll(spread, {
            left: 0,
            top: 0,
        }, 2)).toBe(1);
        expect(resolvePageIndicatorFromScroll(spread, {
            left: 220,
            top: 0,
        }, 1)).toBe(2);
        const visibleSpread = {
            ...spread,
            viewportHeight: 1_000,
        };
        expect(resolvePageIndicatorFromScroll(visibleSpread, {
            left: 0,
            top: 0,
        }, 2)).toBe(2);
    });

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

    it('includes page-track padding when projecting a horizontally panned zoomed page', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [{
                width: 600,
                height: 800,
            }],
            totalPages: 1,
            viewMode: 'single',
            scale: 3,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) throw new Error('Expected layout');
        const geometry = createPdfViewportGeometryFromLayout(layout, {
            width: 1_000,
            height: 800,
            paddingInline: 20,
        }, 1);
        expect(geometry.contentWidth).toBe(1_840);
        const anchor = resolveAnchorFromScroll(geometry, {
            left: 400,
            top: 600,
        });
        expect(anchor.pageXFraction).toBe(880 / 1_800);
        const resized = createPdfViewportGeometryFromLayout(layout, {
            width: 800,
            height: 800,
            paddingInline: 20,
        }, 2);
        expect(resolveScrollForAnchor(resized, anchor)).toEqual({
            left: 500,
            top: 600,
        });
    });

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

    it('resolves the visible page from the session-owned physical scroll origin', () => {
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

        const origin = resolveLayoutPhysicalScrollOrigin(layout, 10_200_020, 1_000, null);
        const visibility = getViewportVisibilityFromLayout(
            {
                clientHeight: 1_000,
                clientWidth: 1_000,
                scrollTop: 10_200_020 - origin,
                scrollLeft: 0,
            } as HTMLElement,
            pageMetrics.length,
            layout,
            origin,
        );

        expect(visibility).toEqual({
            range: {
                start: 10_001,
                end: 10_001,
            },
            mostVisiblePage: 10_001,
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

function createPhysicalScrollLayout(mixedHeights: boolean, scale = 2) {
    const totalPages = 21_601;
    const layout = buildPageLayoutMetrics({
        pageMetrics: normalizePageMetrics({
            pageMetrics: Array.from({length: totalPages}, (_, index) => ({
                width: 595,
                height: mixedHeights && index % 3 === 1 ? 595 : 842,
            })),
            totalPages,
            fallbackWidth: 595,
            fallbackHeight: 842,
        }),
        totalPages,
        viewMode: 'single',
        scale,
        gap: 20,
        paddingTop: 20,
        paddingBottom: 20,
    });
    if (!layout) throw new Error('Expected page layout');
    return layout;
}

describe.each([
    {
        name: 'uniform',
        mixedHeights: false,
    },
    {
        name: 'mixed-height',
        mixedHeights: true,
    },
])('physical scroll segments with $name pages', ({mixedHeights}) => {
    const viewportHeight = 1_000;

    it('uses no segment and resets the origin to zero when the document fits', () => {
        const layout = createPhysicalScrollLayout(mixedHeights, 0.1);
        expect(getLayoutContentHeight(layout)).toBeLessThan(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
        expect(getLayoutPhysicalScrollSegment(layout, 0)).toBeNull();
        expect(resolveLayoutPhysicalScrollOrigin(layout, 0, viewportHeight, null)).toBe(0);
        expect(resolveLayoutPhysicalScrollOrigin(layout, 100_000, viewportHeight, 50_000)).toBe(0);
    });

    it('keeps the owned origin until a viewport enters an end margin and then recentres the same document offset', () => {
        const layout = createPhysicalScrollLayout(mixedHeights);
        const origin = resolveLayoutPhysicalScrollOrigin(
            layout, PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT + viewportHeight, viewportHeight, null,
        );
        expect(origin).toBeGreaterThan(0);
        for (const top of [
            origin + viewportHeight,
            origin + PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT / 2,
            origin + PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT - 2 * viewportHeight,
        ]) {
            expect(resolveLayoutPhysicalScrollOrigin(layout, top, viewportHeight, origin)).toBe(origin);
        }

        for (const top of [
            origin + viewportHeight - 1,
            origin + PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT - 2 * viewportHeight + 1,
        ]) {
            const nextOrigin = resolveLayoutPhysicalScrollOrigin(layout, top, viewportHeight, origin);
            if (top < origin + viewportHeight) {
                expect(nextOrigin).toBeLessThan(origin);
            } else {
                expect(nextOrigin).toBeGreaterThan(origin);
            }
            const physicalTop = top - nextOrigin;
            expect(physicalTop).toBeGreaterThanOrEqual(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT / 2);
            expect(physicalTop).toBeLessThan(
                PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT / 2 + layout.base.maxPageHeight * layout.scale + layout.gap,
            );
            expect(resolveLayoutPhysicalScrollOrigin(layout, top, viewportHeight, nextOrigin)).toBe(nextOrigin);
        }
    });

    it('replaces an origin that a same-scale reflow left inside a row', () => {
        const before = createPhysicalScrollLayout(false);
        const after = createPhysicalScrollLayout(true);
        const top = PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT + 12_345;
        const origin = resolveLayoutPhysicalScrollOrigin(before, top, viewportHeight, null);
        const reflowed = resolveLayoutPhysicalScrollOrigin(after, top, viewportHeight, origin);
        const segment = getLayoutPhysicalScrollSegment(after, reflowed);
        if (!segment) throw new Error('Expected physical scroll segment');
        const firstRow = after.base.pageRowIndices[segment.firstPage - 1]!;
        expect(reflowed).not.toBe(origin);
        expect(getLayoutRowTop(after, firstRow) - reflowed).toBe(after.paddingTop);
        expect(resolveLayoutPhysicalScrollOrigin(after, top, viewportHeight, reflowed)).toBe(reflowed);
    });

    it('aligns every segment origin to its first whole row and excludes preceding rows', () => {
        const layout = createPhysicalScrollLayout(mixedHeights);
        for (const top of [
            0,
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT - 100,
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT + 12_345,
            getLayoutContentHeight(layout) / 2,
            getLayoutContentHeight(layout) - viewportHeight,
        ]) {
            const origin = resolveLayoutPhysicalScrollOrigin(layout, top, viewportHeight, null);
            const segment = getLayoutPhysicalScrollSegment(layout, origin);
            if (!segment) throw new Error('Expected physical scroll segment');
            const firstRow = layout.base.pageRowIndices[segment.firstPage - 1]!;
            expect(segment.origin).toBe(origin);
            expect(getLayoutRowTop(layout, firstRow) - origin).toBe(layout.paddingTop);
            expect(layout.base.rowStartPages[firstRow]).toBe(segment.firstPage);
            if (firstRow > 0) {
                expect(getLayoutRowTop(layout, firstRow - 1) - layout.paddingTop).toBeLessThan(origin);
                expect(layout.base.rowEndPages[firstRow - 1]).toBeLessThan(segment.firstPage);
            }
        }
    });

    it('reaches both document endpoints and ends the last whole-row segment exactly at the content height', () => {
        const layout = createPhysicalScrollLayout(mixedHeights);
        const contentHeight = getLayoutContentHeight(layout);
        const lastOrigin = resolveLayoutPhysicalScrollOrigin(layout, contentHeight - viewportHeight, viewportHeight, 0);
        const last = getLayoutPhysicalScrollSegment(layout, lastOrigin);
        if (!last) throw new Error('Expected last physical scroll segment');
        expect(last.origin + last.height).toBe(contentHeight);
        expect(last.lastPage).toBe(layout.base.totalPages);
        expect(last.height).toBeGreaterThan(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
        expect(last.height).toBeLessThan(
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT + layout.base.maxPageHeight * layout.scale + layout.gap,
        );
        expect(resolveLayoutPhysicalScrollOrigin(layout, contentHeight - viewportHeight, viewportHeight, lastOrigin))
            .toBe(lastOrigin);

        const firstOrigin = resolveLayoutPhysicalScrollOrigin(layout, 0, viewportHeight, lastOrigin);
        expect(firstOrigin).toBe(0);
        expect(getLayoutPhysicalScrollSegment(layout, firstOrigin)?.firstPage).toBe(1);
        expect(resolveLayoutPhysicalScrollOrigin(layout, 0, viewportHeight, firstOrigin)).toBe(0);
    });

    it('keeps a row crossing the 8 MiB mark wholly inside the segment shown over it', () => {
        const layout = createPhysicalScrollLayout(mixedHeights);
        const row = layout.base.rowStartPages.findIndex((_, index) =>
            getLayoutRowTop(layout, index) + getLayoutRowHeight(layout, index) > PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
        );
        expect(row).toBeGreaterThan(0);
        const rowTop = getLayoutRowTop(layout, row);
        const rowBottom = rowTop + getLayoutRowHeight(layout, row);
        expect(rowTop).toBeLessThan(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
        expect(rowBottom).toBeGreaterThan(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
        const origin = resolveLayoutPhysicalScrollOrigin(layout, PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT, viewportHeight, 0);
        const segment = getLayoutPhysicalScrollSegment(layout, origin);
        if (!segment) throw new Error('Expected physical scroll segment');
        expect(segment.firstPage).toBeLessThanOrEqual(layout.base.rowStartPages[row]!);
        expect(segment.lastPage).toBeGreaterThanOrEqual(layout.base.rowEndPages[row]!);
        expect(rowTop - origin).toBeGreaterThanOrEqual(layout.paddingTop);
        expect(rowBottom - origin).toBeLessThanOrEqual(segment.height);
    });

    it('clamps anchor scroll targets to the physical segment height rather than the remaining document height', () => {
        const layout = createPhysicalScrollLayout(mixedHeights);
        for (const top of [
            0,
            PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT + 12_345,
            getLayoutContentHeight(layout) - viewportHeight,
        ]) {
            const origin = resolveLayoutPhysicalScrollOrigin(layout, top, viewportHeight, null);
            const segment = getLayoutPhysicalScrollSegment(layout, origin);
            if (!segment) throw new Error('Expected physical scroll segment');
            const geometry = createPdfViewportGeometryFromLayout(layout, {
                width: 1_000,
                height: viewportHeight,
            }, 1, origin);
            expect(geometry.physicalScrollHeight).toBe(segment.height);
            const maxTop = geometry.physicalScrollHeight - viewportHeight;
            for (const page of [
                segment.firstPage,
                segment.lastPage,
                layout.base.totalPages,
            ]) {
                for (const pageYFraction of [
                    0,
                    0.5,
                    1,
                ]) {
                    const scroll = resolveScrollForAnchor(geometry, {
                        page,
                        pageXFraction: 0.5,
                        pageYFraction,
                        viewportXFraction: 0.5,
                        viewportYFraction: 0,
                        affinity: 'start',
                    });
                    expect(scroll.top).toBeGreaterThanOrEqual(0);
                    expect(scroll.top).toBeLessThanOrEqual(maxTop);
                    if (page === layout.base.totalPages && pageYFraction === 1) expect(scroll.top).toBe(maxTop);
                }
            }
        }
    });
});
