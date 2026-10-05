import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildPageLayoutMetrics,
    getLayoutContentHeight,
    getLayoutPageHeight,
    getLayoutPageTop,
    getLayoutRowHeight,
    cloneSparsePageMetrics,
    getPageMetricMaximum,
    isSparsePageMetricCollection,
    normalizePageMetrics,
    projectPdfPageMetricForView,
    PDF_PAGE_METRICS_DENSE_LIMIT,
} from '@app/modules/document-viewer/public';
import { getLeadingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getLeadingSpacerHeightForPage';
import { getTrailingSpacerHeightForPage } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getTrailingSpacerHeightForPage';
import { resolveDocumentBaseMetric } from '@app/modules/pdf-viewer/engine/pdf-page-layout/resolveDocumentBaseMetric';
import type { IPdfPageMetric } from '@app/types/pdfUi';
import {requirePageIndex} from '@contracts/pageNumbers';

describe('pdfPageLayout', () => {
    it('reuses immutable base topology across scale-only changes', () => {
        const pageMetrics = Array.from({length: 10_000}, (_, index) => ({
            width: 300 + index % 3,
            height: 500 + index % 5,
        }));
        const createLayout = (scale: number, pageMetricsVersion = 1) => buildPageLayoutMetrics({
            pageMetrics,
            pageMetricsVersion,
            totalPages: pageMetrics.length,
            viewMode: 'facing',
            scale,
            gap: 17,
            paddingTop: 19,
            paddingBottom: 23,
        });

        const first = createLayout(1);
        const scaled = createLayout(1.375);
        const revised = createLayout(1.375, 2);
        expect(first?.base).toBe(scaled?.base);
        expect(revised?.base).not.toBe(first?.base);
        expect(Object.isFrozen(first?.base)).toBe(true);
        expect(Object.isFrozen(first?.base.pageHeights)).toBe(true);
        expect(Object.keys(scaled ?? {}).sort()).toEqual([
            'base',
            'gap',
            'paddingBottom',
            'paddingTop',
            'scale',
        ]);
        expect(scaled?.gap).toBe(17);
        expect(scaled?.paddingTop).toBe(19);
        expect(scaled?.paddingBottom).toBe(23);
    });

    it('builds per-page tops from variable page heights', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 400,
                    height: 100,
                },
                {
                    width: 300,
                    height: 200,
                },
                {
                    width: 500,
                    height: 120,
                },
            ],
            totalPages: 3,
            viewMode: 'single',
            scale: 2,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });

        expect(layout).not.toBeNull();
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageTop(layout, requirePageIndex(index)))).toEqual([
            20,
            240,
            660,
        ]);
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageHeight(layout, requirePageIndex(index)))).toEqual([
            200,
            400,
            240,
        ]);
    });

    it('groups facing pages into spread rows and keeps row spacer math aligned', () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 300,
                    height: 100,
                },
                {
                    width: 280,
                    height: 140,
                },
                {
                    width: 320,
                    height: 120,
                },
                {
                    width: 260,
                    height: 160,
                },
                {
                    width: 240,
                    height: 110,
                },
            ],
            totalPages: 5,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });

        expect(layout).not.toBeNull();
        expect(layout && layout.base.pageHeights.map((_height, index) => getLayoutPageTop(layout, requirePageIndex(index)))).toEqual([
            20,
            20,
            180,
            180,
            360,
        ]);
        expect(layout?.base.pageRowIndices).toEqual([
            0,
            0,
            1,
            1,
            2,
        ]);
        expect(layout?.base.rowStartPages).toEqual([
            1,
            3,
            5,
        ]);
        expect(layout?.base.rowEndPages).toEqual([
            2,
            4,
            5,
        ]);
        expect(layout && layout.base.rowHeights.map((_height, index) => getLayoutRowHeight(layout, index))).toEqual([
            140,
            160,
            110,
        ]);
        expect(layout && getLayoutContentHeight(layout)).toBe(490);
        expect(getLeadingSpacerHeightForPage(layout!, 3)).toBe(140);
        expect(getTrailingSpacerHeightForPage(layout!, 2)).toBe(290);
    });

    it('resolves document base dimensions from mixed page sizes', () => {
        const pageMetrics = [
            {
                width: 300,
                height: 500,
            },
            {
                width: 320,
                height: 480,
            },
            {
                width: 700,
                height: 450,
            },
            {
                width: 280,
                height: 900,
            },
        ];

        expect(resolveDocumentBaseMetric(pageMetrics, 'width')).toBe(700);
        expect(resolveDocumentBaseMetric(pageMetrics, 'height')).toBe(900);
    });

    it('estimates missing page metrics from nearest known pages instead of the widest fallback', () => {
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 500,
        };
        sparseMetrics[3] = {
            width: 320,
            height: 520,
        };

        expect(normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages: 5,
            fallbackWidth: 1200,
            fallbackHeight: 1600,
        })).toEqual([
            {
                width: 300,
                height: 500,
            },
            {
                width: 300,
                height: 500,
            },
            {
                width: 320,
                height: 520,
            },
            {
                width: 320,
                height: 520,
            },
            {
                width: 320,
                height: 520,
            },
        ]);
    });

    it('projects layout dimensions for view rotation without changing source metrics', () => {
        const sourceMetric = {
            width: 600,
            height: 800,
            rotation: 90,
            userUnit: 2,
        } satisfies IPdfPageMetric;

        expect(projectPdfPageMetricForView(sourceMetric, 90)).toEqual({
            width: 800,
            height: 600,
            rotation: 90,
            userUnit: 2,
        });
        expect(projectPdfPageMetricForView(sourceMetric, 270)).toEqual({
            width: 800,
            height: 600,
            rotation: 90,
            userUnit: 2,
        });
        expect(projectPdfPageMetricForView(sourceMetric, 180)).toEqual(sourceMetric);
        expect(sourceMetric).toEqual({
            width: 600,
            height: 800,
            rotation: 90,
            userUnit: 2,
        });
    });

    it('uses projected dimensions for dense and sparse normalized layout metrics', () => {
        const dense = normalizePageMetrics({
            pageMetrics: [{
                width: 600,
                height: 800,
            }],
            totalPages: 1,
            fallbackWidth: 600,
            fallbackHeight: 800,
            viewRotation: 90,
        });
        expect(dense).toEqual([{
            width: 800,
            height: 600,
        }]);

        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 600,
            height: 800,
        };
        sparseMetrics[100_000] = {
            width: 700,
            height: 500,
        };
        const sparse = normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages: 100_001,
            fallbackWidth: 600,
            fallbackHeight: 800,
            viewRotation: 90,
        });
        expect(sparse[0]).toEqual({
            width: 800,
            height: 600,
        });
        expect(sparse[1]).toEqual({
            width: 800,
            height: 600,
        });
        expect(sparse[100_000]).toEqual({
            width: 500,
            height: 700,
        });
        expect(getPageMetricMaximum(sparse, 'width')).toBe(800);
        expect(getPageMetricMaximum(sparse, 'height')).toBe(700);
    });

    it('clones a million-page public metric snapshot without iterating sparse holes', () => {
        const totalPages = 1_000_000;
        const pageMetrics: IPdfPageMetric[] = [];
        pageMetrics[0] = {
            width: 300,
            height: 500,
        };
        pageMetrics[totalPages - 1] = {
            width: 320,
            height: 520,
        };
        const iteratorSpy = vi.spyOn(pageMetrics, Symbol.iterator).mockImplementation(() => {
            throw new Error('sparse public snapshots must not iterate metrics');
        });

        try {
            const snapshot = cloneSparsePageMetrics(pageMetrics);
            expect(snapshot.length).toBe(totalPages);
            expect(snapshot[0]).toEqual(pageMetrics[0]);
            expect(snapshot[totalPages - 1]).toEqual(pageMetrics[totalPages - 1]);
            expect(Object.keys(snapshot).filter(key => /^\d+$/.test(key))).toHaveLength(2);
        } finally {
            iteratorSpy.mockRestore();
        }
    });

    it('normalizes a million-page sparse metric source without a dense fill', () => {
        const totalPages = 1_000_000;
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 500,
        };
        sparseMetrics[totalPages - 1] = {
            width: 320,
            height: 520,
            rotation: 90,
            userUnit: 2,
        };

        const arrayFromSpy = vi.spyOn(Array, 'from');
        let normalized: IPdfPageMetric[];
        try {
            normalized = normalizePageMetrics({
                pageMetrics: sparseMetrics,
                totalPages,
                fallbackWidth: 1200,
                fallbackHeight: 1600,
            });
        } finally {
            arrayFromSpy.mockRestore();
        }

        expect(arrayFromSpy).not.toHaveBeenCalled();
        expect(Array.isArray(normalized)).toBe(true);
        expect(normalized.length).toBe(totalPages);
        expect(isSparsePageMetricCollection(normalized)).toBe(true);
        expect(normalized[0]).toEqual({
            width: 300,
            height: 500,
        });
        const firstEstimate = normalized[1];
        expect(firstEstimate).toEqual({
            width: 300,
            height: 500,
        });
        expect(normalized[totalPages - 1]).toEqual({
            width: 320,
            height: 520,
            rotation: 90,
            userUnit: 2,
        });
        expect(normalized[1]).toBe(firstEstimate);
        expect(getPageMetricMaximum(normalized, 'height')).toBe(1600);
        expect((normalized as typeof normalized & {knownIndices: readonly number[];}).knownIndices).toEqual([
            0,
            totalPages - 1,
        ]);
    });

    it('keeps the dense boundary explicit and switches to sparse layout above it', () => {
        const createSparseMetrics = (totalPages: number) => {
            const metrics: IPdfPageMetric[] = [];
            metrics[0] = {
                width: 300,
                height: 500,
            };
            metrics[totalPages - 1] = {
                width: 320,
                height: 520,
            };
            return metrics;
        };
        const atLimit = normalizePageMetrics({
            pageMetrics: createSparseMetrics(PDF_PAGE_METRICS_DENSE_LIMIT),
            totalPages: PDF_PAGE_METRICS_DENSE_LIMIT,
            fallbackWidth: 1200,
            fallbackHeight: 1600,
        });
        const aboveLimit = normalizePageMetrics({
            pageMetrics: createSparseMetrics(PDF_PAGE_METRICS_DENSE_LIMIT + 1),
            totalPages: PDF_PAGE_METRICS_DENSE_LIMIT + 1,
            fallbackWidth: 1200,
            fallbackHeight: 1600,
        });

        expect(isSparsePageMetricCollection(atLimit)).toBe(false);
        expect(isSparsePageMetricCollection(aboveLimit)).toBe(true);

        const arrayFromSpy = vi.spyOn(Array, 'from');
        try {
            const layout = buildPageLayoutMetrics({
                pageMetrics: aboveLimit,
                pageMetricsVersion: 1,
                totalPages: PDF_PAGE_METRICS_DENSE_LIMIT + 1,
                viewMode: 'single',
                scale: 1,
                gap: 12,
                paddingTop: 8,
                paddingBottom: 8,
            });

            expect(arrayFromSpy).not.toHaveBeenCalled();
            expect(layout?.base.isSparse).toBe(true);
            expect(Object.keys(layout?.base.pageWidths ?? []).filter(key => /^\d+$/.test(key))).toHaveLength(0);
        } finally {
            arrayFromSpy.mockRestore();
        }
    });

    it('keeps the 25k-page PDF layout sparse for bounded metric updates', () => {
        const totalPages = 25_000;
        const pageMetrics: IPdfPageMetric[] = [];
        pageMetrics[0] = {
            width: 300,
            height: 500,
        };

        const normalized = normalizePageMetrics({
            pageMetrics,
            totalPages,
            fallbackWidth: 640,
            fallbackHeight: 900,
        });

        expect(isSparsePageMetricCollection(normalized)).toBe(true);
        expect(normalized.length).toBe(totalPages);
        expect(normalized[0]?.width).toBe(300);
        expect(normalized[0]?.height).toBe(500);
        expect(Object.keys(normalized).filter(key => /^\d+$/u.test(key))).toEqual([]);
    });

    it('builds early million-page layout lookups from chunked rows and prefixes', () => {
        const totalPages = 1_000_000;
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 500,
        };
        sparseMetrics[100] = {
            width: 700,
            height: 1000,
        };
        sparseMetrics[totalPages - 1] = {
            width: 320,
            height: 520,
        };
        const normalized = normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages,
            fallbackWidth: 1200,
            fallbackHeight: 1600,
        });
        const arrayFromSpy = vi.spyOn(Array, 'from');
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
        arrayFromSpy.mockRestore();

        expect(arrayFromSpy).not.toHaveBeenCalled();
        expect(layout).not.toBeNull();
        expect(layout?.base.pageWidths.length).toBe(totalPages);
        expect(layout?.base.pageRowIndices.length).toBe(totalPages);
        expect(layout?.base.rowStartPages.length).toBe(500_000);
        expect(layout?.base.pageRowIndices[0]).toBe(0);
        expect(layout?.base.pageRowIndices[1]).toBe(0);
        expect(layout?.base.pageRowIndices[totalPages - 1]).toBe(499_999);
        expect(layout?.base.rowStartPages[0]).toBe(1);
        expect(layout?.base.rowEndPages[0]).toBe(2);
        expect(layout?.base.rowStartPages[499_999]).toBe(999_999);
        expect(layout?.base.rowEndPages[499_999]).toBe(totalPages);
        expect(layout && getLayoutPageTop(layout, requirePageIndex(0))).toBe(8);
        expect(layout && getLayoutPageHeight(layout, requirePageIndex(totalPages - 1))).toBe(520);
        expect(layout?.base.rowHeights[0]).toBe(500);
        expect(layout?.base.rowHeights[499_999]).toBe(520);
        expect(layout?.base.pageHeightPrefixSums[0]).toBe(500);
        expect(layout?.base.pageHeightPrefixSums[300]).toBe(275_500);
        expect(layout?.base.rowHeightPrefixSums[0]).toBe(500);
        expect(layout?.base.rowHeightPrefixSums[1]).toBe(1_000);
        expect(layout?.base.rowHeightPrefixSums[30]).toBe(18_500);
        expect(Object.keys(layout?.base.pageWidths ?? []).filter(key => /^\d+$/.test(key))).toHaveLength(0);
    });

    it('keeps exact prefix corrections after distant chunks are evicted', () => {
        const totalPages = 1_000_000;
        const sparseMetrics: IPdfPageMetric[] = [];
        sparseMetrics[0] = {
            width: 300,
            height: 100,
        };
        const normalized = normalizePageMetrics({
            pageMetrics: sparseMetrics,
            totalPages,
            fallbackWidth: 300,
            fallbackHeight: 100,
        });
        sparseMetrics[256] = {
            width: 300,
            height: 900,
        };
        const layout = buildPageLayoutMetrics({
            pageMetrics: normalized,
            pageMetricsVersion: 1,
            totalPages,
            viewMode: 'single',
            scale: 1,
            gap: 0,
            paddingTop: 0,
            paddingBottom: 0,
        });

        expect(layout?.base.pageHeightPrefixSums[256]).toBe(26_500);
        for (let block = 2; block < 80; block += 1) {
            void layout?.base.pageHeightPrefixSums[block * 256];
        }
        // Block one has left the 32-block value cache, but its sparse exact
        // correction remains in the prefix tree.
        expect(layout?.base.pageHeightPrefixSums[512]).toBe(52_100);
    });
});
