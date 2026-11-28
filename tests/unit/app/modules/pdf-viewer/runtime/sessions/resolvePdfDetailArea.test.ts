// @vitest-environment happy-dom
import {describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import {requirePageNumber} from '@contracts/pageNumbers';
import {createPdfDetailRaster, resolvePdfDetailArea} from '@app/modules/pdf-viewer/runtime/sessions/createPdfDetailRaster';
import {createPdfPageResources} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageResources';
import type {IPdfPageRasterScheduler} from '@app/modules/pdf-viewer/engine/pdf-page-raster-scheduler/pdfPageRasterScheduler';
import {cast} from '@tests/helpers/cast';

// An A4 page at 1000 % on a 2x display, with the default tier's detail budget.
const page = {
    pageWidth: 5960,
    pageHeight: 8420,
    outputScale: 2,
    budgetPixels: 2 ** 24,
};
const visible = {
    x0: 0.4,
    y0: 0.4,
    x1: 0.55,
    y1: 0.45,
};

describe('resolvePdfDetailArea', () => {
    it('adds a margin of half the visible size around a small visible part', () => {
        const area = resolvePdfDetailArea({
            ...page,
            visible,
            baseDensity: 0.3,
            current: null,
        });
        expect(area).toEqual({
            x0: 0.325,
            y0: 0.375,
            x1: 0.625,
            y1: 0.475,
        });
    });

    it('clips the region to the page edge', () => {
        const area = resolvePdfDetailArea({
            ...page,
            visible: {
                x0: 0,
                y0: 0.95,
                x1: 0.1,
                y1: 1,
            },
            baseDensity: 0.3,
            current: null,
        });
        expect(area).toEqual({
            x0: 0,
            y0: 0.925,
            x1: 0.15,
            y1: 1,
        });
    });

    it('keeps the shown region while it covers the visible part with balanced margins', () => {
        expect(
            resolvePdfDetailArea({
                ...page,
                visible: {
                    x0: 0.42,
                    y0: 0.41,
                    x1: 0.57,
                    y1: 0.46,
                },
                baseDensity: 0.3,
                current: {
                    x0: 0.325,
                    y0: 0.375,
                    x1: 0.625,
                    y1: 0.475,
                },
            }),
        ).toBe('current');
    });

    it('re-centres once the margin ahead of a pan falls under a third of the one behind', () => {
        expect(
            resolvePdfDetailArea({
                ...page,
                visible: {
                    x0: 0.47,
                    y0: 0.4,
                    x1: 0.62,
                    y1: 0.45,
                },
                baseDensity: 0.3,
                current: {
                    x0: 0.325,
                    y0: 0.375,
                    x1: 0.625,
                    y1: 0.475,
                },
            }),
        ).toEqual({
            x0: 0.395,
            y0: 0.375,
            x1: 0.695,
            y1: 0.475,
        });
    });

    it('makes no detail where the whole-page raster is already nearly as sharp', () => {
        expect(
            resolvePdfDetailArea({
                ...page,
                visible,
                baseDensity: 0.95,
                current: null,
            }),
        ).toBeNull();
    });

    it('makes no detail when the budget leaves it no sharper than the page raster', () => {
        // The visible part alone exceeds the budget: 0.9 of a 2x A4 page at
        // 1000 % is 1.8e8 device pixels against 1.7e7.
        expect(
            resolvePdfDetailArea({
                ...page,
                visible: {
                    x0: 0,
                    y0: 0,
                    x1: 0.9,
                    y1: 1,
                },
                baseDensity: 0.3,
                current: null,
            }),
        ).toBeNull();
    });

    it('reads viewerContainer.getBoundingClientRect at most once per reconcile across multiple clamped pages', () => {
        const viewer = document.createElement('div');
        Object.defineProperty(viewer, 'clientLeft', {value: 0});
        Object.defineProperty(viewer, 'clientTop', {value: 0});
        Object.defineProperty(viewer, 'clientWidth', {value: 600});
        Object.defineProperty(viewer, 'clientHeight', {value: 800});
        const viewerRectSpy = vi.spyOn(viewer, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 800));

        const makePageContainer = (top: number) => {
            const container = document.createElement('div');
            const surface = document.createElement('div');
            surface.className = 'page_canvas';
            vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 6000, 8400));
            const detailHost = document.createElement('div');
            container.append(surface, detailHost);
            return {container, detailHost};
        };
        const targets = new Map([
            [requirePageNumber(1), makePageContainer(0)],
            [requirePageNumber(2), makePageContainer(300)],
        ]);
        const pageResources = createPdfPageResources();
        const setDemand = vi.fn();
        const scheduler = cast<IPdfPageRasterScheduler>({
            documentFence: {loadToken: 1, documentVersion: 1, documentRevision: null},
            setDemand,
            invalidate: vi.fn(),
            cancelSource: vi.fn(async () => undefined),
            releaseSource: vi.fn(async () => undefined),
        });
        for (const pageNumber of [requirePageNumber(1), requirePageNumber(2)]) {
            const job = cast<Parameters<typeof pageResources.want>[1]>({
                requestId: pageNumber,
                demand: {
                    pageNumber,
                    renderKey: `k:${pageNumber}`,
                    lane: 'viewport-visible',
                    ordinal: pageNumber,
                    estimatedPixels: 100,
                    retention: 'render-cache',
                    documentFence: scheduler.documentFence,
                    consumerGeneration: 1,
                },
                rasterIdentity: 'id',
                rasterState: 'current',
                renderOptions: {},
                targetOutputScale: 2,
                targetScale: 10,
                targetViewRotation: 0,
            })!;
            pageResources.want(pageNumber, job);
            pageResources.publish(pageNumber, job, {
                render: cast({canvas: {width: 4096, height: 4096}}),
                quality: {
                    requestedPixels: 100_000_000,
                    grantedPixels: 16_777_216,
                    pixelScaleFactor: 0.3,
                    wasClamped: true,
                    intent: 'settled',
                    paintsAnnotations: true,
                },
                container: targets.get(pageNumber)!.container,
                documentToken: 'doc',
                version: 1,
                layers: 'canvas-only',
            });
        }
        const detail = createPdfDetailRaster({
            sourceId: 'detail',
            budgetPixels: 2 ** 24,
            settledMaxCanvasPixels: 2 ** 25,
            canvasRenderer: cast({prepareCanvasRender: vi.fn(), cleanupCanvasRenderResult: vi.fn()}),
            pageResources,
            viewerContainer: ref(viewer),
            getScheduler: () => scheduler,
            getDocument: () => ({}),
            getMountedTarget: (p) => targets.get(p) ?? null,
            getScale: () => 10,
            getOutputScale: () => 2,
            getRotation: () => 0,
            getHiddenAnnotationIds: () => new Set<string>(),
            getSourceMaxPixels: () => null,
            isCommittedVisual: () => true,
            canStartWork: () => true,
        });

        detail.reconcile([requirePageNumber(1), requirePageNumber(2)], true);
        expect(viewerRectSpy).toHaveBeenCalledTimes(1);
        expect(setDemand).toHaveBeenCalledTimes(1);
    });
});
