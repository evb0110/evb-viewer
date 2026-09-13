import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    resolveDocumentPageDisplayLayoutsBounded,
    resolveDocumentPageHeightsBounded,
    resolveDocumentPageLayoutsBounded,
    resolveDocumentPageSourceReadyEdgeSemanticPage,
    resolveDocumentPageTopsBounded,
    resolveDocumentPageZoomAnchorLayoutsBounded,
} from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';
import {
    createProvisionalDocumentPageMetrics,
    isSparseDocumentPageMetrics,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import {DOCUMENT_PAGE_GUTTER_PX} from '@app/modules/document-viewer/layout/documentPageGutterPx';
import {
    createLazyIndexedCollection,
    isLazyIndexedCollection,
} from '@app/modules/document-viewer/virtualization/pageVirtualization';

describe('document page-source ready-edge reconciliation', () => {
    it('preserves the committed navigation target until a trusted page is observed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBe(11);
    });

    it('falls back to the requested page when no page is committed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: null,
            observedPage: null,
        })).toBe(11);
    });

    it('does not reconcile before the viewport session is ready', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'opening',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBeNull();
    });

    it('leaves a physically observed page for viewport reconciliation', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: 18,
        })).toBeNull();
    });
});

describe('document page-source layout memory bounds', () => {
    it('projects a generic lazy page source without invoking array map', () => {
        const metrics = createLazyIndexedCollection({
            cacheValues: false,
            getValue: () => ({
                widthPoints: 600,
                heightPoints: 800,
                rotation: 0 as const,
            }),
            length: 1_000_000,
        });
        Object.defineProperty(metrics, 'map', {
            configurable: true,
            value: () => {
                throw new Error('generic lazy page metrics must not be mapped');
            },
        });

        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        const pageHeights = resolveDocumentPageHeightsBounded(displayLayouts);
        const pageTops = resolveDocumentPageTopsBounded(pageHeights);
        const pageLayouts = resolveDocumentPageLayoutsBounded(
            displayLayouts,
            pageTops,
            true,
        );
        const zoomAnchorLayouts = resolveDocumentPageZoomAnchorLayoutsBounded(
            pageLayouts,
            pageWidth => Math.max(DOCUMENT_PAGE_GUTTER_PX, (800 - pageWidth) / 2),
        );

        for (const collection of [
            displayLayouts,
            pageHeights,
            pageTops,
            pageLayouts,
            zoomAnchorLayouts,
        ]) {
            expect(isLazyIndexedCollection(collection)).toBe(true);
            expect(Object.keys(collection).filter(key => /^\d+$/u.test(key))).toEqual([]);
            expect(collection).toHaveLength(1_000_000);
        }
        expect(zoomAnchorLayouts[0]).toMatchObject({
            left: 100,
            top: 20,
            width: 600,
            height: 800,
        });
    });

    it('keeps sparse million-page display layouts lazy and on-demand', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        expect(isSparseDocumentPageMetrics(metrics)).toBe(true);

        const layouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );

        expect(isLazyIndexedCollection(layouts)).toBe(true);
        expect(Object.keys(layouts).filter(key => /^\d+$/u.test(key))).toEqual([]);
        expect(layouts).toHaveLength(1_000_000);
        expect(layouts[999_999]).toMatchObject({
            width: 600,
            height: 800,
        });
    });

    it('estimates sparse page tops without scanning every page metric', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        if (!isSparseDocumentPageMetrics(metrics)) {
            throw new Error('expected sparse metrics');
        }
        const getMetric = vi.spyOn(metrics, 'get');
        metrics.setExact(1, {
            widthPoints: 600,
            heightPoints: 1_000,
            rotation: 0,
        });
        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        const pageHeights = resolveDocumentPageHeightsBounded(displayLayouts);
        const pageTops = resolveDocumentPageTopsBounded(pageHeights);
        const lastPageIndex = 999_999;

        expect(pageTops[lastPageIndex]).toBe(
            DOCUMENT_PAGE_GUTTER_PX
            + (1_000 - 800)
            + lastPageIndex * (800 + DOCUMENT_PAGE_GUTTER_PX),
        );
        expect(getMetric.mock.calls.length).toBeLessThan(1_000);
    });

    it('keeps every sparse continuous layout collection lazy without mapping the document', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        Object.defineProperty(displayLayouts, 'map', {
            configurable: true,
            value: () => {
                throw new Error('sparse page layouts must not be mapped');
            },
        });

        const pageHeights = resolveDocumentPageHeightsBounded(displayLayouts);
        const pageTops = resolveDocumentPageTopsBounded(pageHeights);
        const pageLayouts = resolveDocumentPageLayoutsBounded(
            displayLayouts,
            pageTops,
            true,
        );

        for (const collection of [
            pageHeights,
            pageTops,
            pageLayouts,
        ]) {
            expect(isLazyIndexedCollection(collection)).toBe(true);
            expect(Object.keys(collection).filter(key => /^\d+$/u.test(key))).toEqual([]);
            expect(collection).toHaveLength(1_000_000);
        }
        expect(pageHeights[0]).toBe(800);
        expect(pageTops[0]).toBe(20);
        expect(pageLayouts[0]).toMatchObject({
            top: 20,
            width: 600,
            height: 800,
        });
    });

    it('computes the last sparse page top without reading every page metric', () => {
        const metrics = createProvisionalDocumentPageMetrics(138_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        if (!isSparseDocumentPageMetrics(metrics)) {
            throw new Error('Expected a sparse page metric collection');
        }
        const getMetric = vi.fn(metrics.get);
        Object.defineProperty(metrics, 'get', {
            configurable: true,
            value: getMetric,
        });

        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        const pageTops = resolveDocumentPageTopsBounded(
            resolveDocumentPageHeightsBounded(displayLayouts),
        );

        expect(pageTops.at(-1)).toBe(20 + (138_000 - 1) * 820);
        expect(getMetric).toHaveBeenCalledTimes(0);
    });

    it('keeps sparse zoom-anchor layouts lazy without mapping the document', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        const pageLayouts = resolveDocumentPageLayoutsBounded(
            displayLayouts,
            resolveDocumentPageTopsBounded(
                resolveDocumentPageHeightsBounded(displayLayouts),
            ),
            true,
        );
        Object.defineProperty(pageLayouts, 'map', {
            configurable: true,
            value: () => {
                throw new Error('sparse page layouts must not be mapped');
            },
        });

        const zoomAnchorLayouts = resolveDocumentPageZoomAnchorLayoutsBounded(
            pageLayouts,
            pageWidth => Math.max(DOCUMENT_PAGE_GUTTER_PX, (800 - pageWidth) / 2),
        );

        expect(isLazyIndexedCollection(zoomAnchorLayouts)).toBe(true);
        expect(Object.keys(zoomAnchorLayouts).filter(key => /^\d+$/u.test(key))).toEqual([]);
        expect(zoomAnchorLayouts).toHaveLength(1_000_000);
        expect(zoomAnchorLayouts[0]).toMatchObject({
            left: 100,
            top: 20,
            width: 600,
            height: 800,
        });
    });
});
