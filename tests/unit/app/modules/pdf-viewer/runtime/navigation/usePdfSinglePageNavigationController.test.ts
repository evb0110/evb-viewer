import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getLayoutPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

function requireLayoutPageTop(layout: IPdfPageLayoutMetrics, pageIndex: number) {
    const top = getLayoutPageTop(layout, pageIndex);
    if (top === null) {
        throw new Error(`Expected a layout top for page index ${String(pageIndex)}`);
    }
    return top;
}

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}

describe('usePdfSinglePageNavigationController', () => {
    it('requests text-first target hydration only for text-layer navigation readiness', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const freshPages = new Set([1]);
        const waitForPageTextLayerReady = vi.fn(async () => true);
        const viewportWrites = createTestPdfViewportWritePort();
        const renderVisiblePages = vi.fn(async (range: {
            start: number;
            end: number
        }) => {
            const target = viewer.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            if (target) {
                target.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div><div class="text-layer" data-pdf-text-layer-ready="true"></div>';
            }
            freshPages.add(range.start);
        });

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages,
                waitForPageTextLayerReady,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.submitNavigationRequest({
                target: {
                    kind: 'rect',
                    page: 2,
                    rect: {
                        left: 0.25,
                        top: 0.75,
                        width: 0.1,
                        height: 0.05,
                    },
                },
                alignment: 'rect-center',
                readiness: 'page-canvas',
                source: 'search',
                supersession: 'latest-wins',
            })).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
            });
            expect(renderVisiblePages).toHaveBeenNthCalledWith(
                1,
                {
                    start: 2,
                    end: 2,
                },
                {
                    authoritativeRaster: true,
                    preserveRenderedPages: true,
                    retainOnlyCurrentResidentRaster: true,
                    suppressResidentRasterDemand: false,
                },
            );
            expect(waitForPageTextLayerReady).not.toHaveBeenCalled();

            expect(controller.submitNavigationRequest({
                target: {
                    kind: 'rect',
                    page: 3,
                    rect: {
                        left: 0.25,
                        top: 0.75,
                        width: 0.1,
                        height: 0.05,
                    },
                },
                alignment: 'rect-center',
                readiness: 'text-layer',
                postArrival: 'search-highlight',
                source: 'search',
                supersession: 'latest-wins',
            })).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
            });
            expect(renderVisiblePages).toHaveBeenNthCalledWith(
                2,
                {
                    start: 3,
                    end: 3,
                },
                {
                    authoritativeRaster: true,
                    preserveRenderedPages: true,
                    prioritizeTextLayer: true,
                    retainOnlyCurrentResidentRaster: true,
                    suppressResidentRasterDemand: false,
                },
            );
            expect(waitForPageTextLayerReady).toHaveBeenCalledOnce();
            expect(waitForPageTextLayerReady).toHaveBeenCalledWith(3, expect.any(AbortSignal));

        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('keeps a pending text-anchor search through an anchored resize preview', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const textLayerReady = createDeferred();
        const freshPages = new Set([1]);
        const waitForPageTextLayerReady = vi.fn(async (_page: number, signal: AbortSignal) => {
            await textLayerReady.promise;
            return !signal.aborted;
        });
        const renderVisiblePages = vi.fn(async (range: {
            start: number;
            end: number
        }) => {
            const target = viewer.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            if (target) {
                target.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div><div class="text-layer"><span>The Lezgian language</span></div>';
                const textLayer = target.querySelector<HTMLElement>('.text-layer');
                if (textLayer) {
                    textLayer.dataset.pdfTextLayerReady = 'false';
                }
            }
            freshPages.add(range.start);
        });
        const viewportWrites = createTestPdfViewportWritePort();
        const searchRange = {
            startOffset: 4,
            endOffset: 11,
        };
        const searchRequest = {
            target: {
                kind: 'text-anchor',
                page: 3,
                text: 'Lezgian',
                prefix: 'The ',
                suffix: ' language',
                pageMatchIndex: 1,
                matchIndex: 7,
                searchQuery: 'Lezgian',
                searchRange,
            },
            alignment: 'rect-center',
            readiness: 'text-layer',
            postArrival: 'search-highlight',
            source: 'search',
            supersession: 'latest-wins',
        } as const;
        const staleResizeAnchor = {
            page: 1,
            pageXFraction: 0.5,
            pageYFraction: 0.2,
            viewportXFraction: 0.5,
            viewportYFraction: 0.5,
            affinity: 'center' as const,
        };

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages,
                waitForPageTextLayerReady,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.submitNavigationRequest(searchRequest)).toBe(true);
            await vi.waitFor(() => {
                expect(waitForPageTextLayerReady).toHaveBeenCalledOnce();
            });
            expect(controller.viewportAuthority.activeIntent.value?.navigation).toEqual(searchRequest);
            expect(controller.viewportAuthority.activeIntent.value?.navigation?.readiness).toBe('text-layer');
            expect(viewportWrites.writes).toHaveLength(0);

            const resize = controller.submitViewportStateIntent('resize', {anchor: staleResizeAnchor});
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.activeIntent.value?.kind).toBe('resize');
            });
            expect(controller.viewportAuthority.activeIntent.value?.navigation).toEqual(searchRequest);
            expect(controller.viewportAuthority.activeIntent.value?.anchor?.page).toBe(3);
            expect(controller.viewportAuthority.getTerminalOutcome('viewport-navigation-1'))
                .toBe('cancelled');

            // Resize lifecycle calls this before and after Vue patches the new
            // geometry. The pending text target owns both calls until it is ready.
            expect(controller.applyResizeAnchorPreview(staleResizeAnchor)).toBeNull();
            await nextTick();
            expect(controller.applyResizeAnchorPreview(staleResizeAnchor)).toBeNull();
            expect(viewportWrites.writes).toHaveLength(0);

            const textLayer = viewer.querySelector<HTMLElement>('.page_container[data-page="3"] .text-layer');
            expect(textLayer).not.toBeNull();
            textLayer!.dataset.pdfTextLayerReady = 'true';
            textLayerReady.resolve();

            await expect(resize).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 3},
            });
            expect(waitForPageTextLayerReady).toHaveBeenCalledTimes(2);
            expect(controller.viewportAuthority.committedAnchor.value?.page).toBe(3);
            expect(viewportWrites.writes).toHaveLength(1);
            expect(viewportWrites.writes[0]).toMatchObject({reason: 'viewport-authority:resize'});
            expect(viewportWrites.writes[0]?.top).toBeGreaterThanOrEqual(
                requireLayoutPageTop(layout, 2) - 20,
            );
            expect(viewportWrites.writes[0]?.top).toBeLessThanOrEqual(
                requireLayoutPageTop(layout, 2),
            );
        } finally {
            textLayerReady.resolve();
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('refines a continuous page jump from the mounted page position', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 4_000},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        viewer.getBoundingClientRect = () => ({
            bottom: 800,
            height: 700,
            left: 0,
            right: 900,
            top: 100,
            width: 900,
            x: 0,
            y: 100,
            toJSON: () => ({}),
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            const contentTop = pageNumber === 1 ? 20 : 2_400;
            page.getBoundingClientRect = () => ({
                bottom: contentTop - viewer.scrollTop + 900,
                height: 900,
                left: 150,
                right: 750,
                top: contentTop - viewer.scrollTop + 100,
                width: 600,
                x: 150,
                y: contentTop - viewer.scrollTop + 100,
                toJSON: () => ({}),
            });
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 2} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(2)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
            });
            expect(requireLayoutPageTop(layout, 1)).toBeLessThan(1_000);
            expect(viewportWrites.writes.at(-1)?.top).toBe(2_380);
            expect(viewer.scrollTop).toBe(2_380);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('clamps a mounted narrow navigation row despite wider document overflow', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 1_604},
            scrollHeight: {value: 4_000},
            scrollWidth: {value: 2_200},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        viewer.getBoundingClientRect = () => ({
            bottom: 700,
            height: 700,
            left: 0,
            right: 1_604,
            top: 0,
            width: 1_604,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        const pageSlots = createPdfPageSlotRegistry();
        const target = document.createElement('div');
        target.className = 'page_container page_container--rendered';
        target.dataset.page = '2';
        target.innerHTML = '<div class="page_canvas"><canvas width="1532" height="800"></canvas></div>';
        target.getBoundingClientRect = () => ({
            bottom: 1_700,
            height: 800,
            left: 36,
            right: 1_568,
            top: 900,
            width: 1_532,
            x: 36,
            y: 900,
            toJSON: () => ({}),
        });
        viewer.append(target);
        pageSlots.markMounted(2);
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 1_532,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 2} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.submitNavigationRequest({
                target: {
                    kind: 'rect',
                    page: 2,
                    rect: {
                        left: 0.9,
                        top: 0.4,
                        width: 0.05,
                        height: 0.05,
                    },
                },
                alignment: 'rect-center',
                readiness: 'page-canvas',
                source: 'toolbar',
                supersession: 'latest-wins',
            })).toBe(true);

            await vi.waitFor(() => {
                expect(viewportWrites.writes).toHaveLength(1);
            });
            expect(viewportWrites.writes[0]).toMatchObject({
                left: 0,
                reason: 'viewport-authority:navigate',
            });
            expect(viewportWrites.writes[0]?.top).toBe(890);
            expect(viewer.scrollLeft).toBe(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('uses page-local scroll coordinates in paged mode instead of the cumulative document track', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 840},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(false),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(3)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
            });
            expect(getLayoutPageTop(layout, 2)).toBeGreaterThan(viewer.scrollHeight);
            expect(viewportWrites.writes.at(-1)?.top).toBe(0);
            expect(viewer.scrollTop).toBe(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('accumulates sustained paged wheel intent while earlier pages are still preparing', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 700},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 5}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 5,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const preparation = createDeferred();
        const viewportWrites = createTestPdfViewportWritePort();
        const preventDefault = vi.fn();
        const requestSurfacePageNavigation = vi.fn((page: number) => page);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(5),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(false),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 5} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                prepareNavigationLayout: async () => preparation.promise,
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                requestSurfacePageNavigation,
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            for (const timeStamp of [
                1_000,
                1_200,
                1_400,
            ]) {
                expect(controller.handleWheel({
                    deltaX: 0,
                    deltaY: 180,
                    preventDefault,
                    timeStamp,
                })).toBe(true);
            }
            expect(controller.navigationAnchorPage.value).toBe(4);
            expect(controller.navigationVisualHandoffTargetPage.value).toBe(4);
            expect(controller.viewportAuthority.currentPage.value).toBe(1);
            expect(preventDefault).toHaveBeenCalledTimes(3);
            expect(requestSurfacePageNavigation.mock.calls).toEqual([
                [2],
                [3],
                [4],
            ]);

            preparation.resolve();
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(4);
            });
            await vi.waitFor(() => {
                expect(controller.navigationVisualHandoffTargetPage.value).toBeNull();
            });
            expect(viewportWrites.writes).toHaveLength(1);
            expect(controller.handleWheel({
                deltaX: 0,
                deltaY: 0,
                preventDefault,
                timeStamp: 1_600,
            })).toBe(false);
            expect(requestSurfacePageNavigation).toHaveBeenCalledTimes(3);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('anchors zoom to the viewport authority page while the outer requested page lags', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const currentPage = ref(1);
        const requestedCurrentPage = ref<number | undefined>(1);
        const isResizeTransitionActive = ref(false);
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isResizeTransitionActive,
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 2} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 2,
                }),
                emitCurrentPage: page => { currentPage.value = page; },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            await expect(controller.submitViewportStateIntent('fit')).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 1},
            });
            expect(controller.viewportAuthority.currentPage.value).toBe(1);

            viewer.scrollTop = 850;
            isResizeTransitionActive.value = true;
            expect(controller.viewportAuthority.currentPage.value).toBe(1);
            expect(controller.currentPageAuthority.canSyncFromViewport()).toBe(false);
            isResizeTransitionActive.value = false;
            const livePageTwoAnchor = controller.captureCurrentSemanticAnchor();
            expect(livePageTwoAnchor?.page).toBe(2);
            controller.viewportAuthority.observeUserScroll(livePageTwoAnchor!);
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(requestedCurrentPage.value).toBe(1);
            const zoom = controller.submitViewportStateIntent('zoom', {zoom: 5.03});
            expect(controller.viewportAuthority.activeIntent.value?.anchor?.page).toBe(2);
            const zoomIntentId = controller.viewportAuthority.activeIntent.value?.id;
            expect(controller.viewportAuthority.activeIntent.value?.id).toBe(zoomIntentId);
            expect(controller.shouldCancelProgrammaticNavigationForViewportScroll()).toBe(false);
            controller.cancelDestinationNavigationTarget();
            expect(controller.viewportAuthority.activeIntent.value?.id).toBe(zoomIntentId);
            await expect(zoom).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 2},
            });
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('anchors a fit intent on the page the user scrolled to, not on the reinterpreted offset', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 5_000},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const buildLayout = (scale: number) => {
            const layout = buildPageLayoutMetrics({
                pageMetrics: Array.from({length: 6}, () => ({
                    width: 600,
                    height: 800,
                })),
                totalPages: 6,
                viewMode: 'single',
                scale,
                gap: 20,
                paddingTop: 20,
                paddingBottom: 20,
            });
            if (!layout) {
                throw new Error('Expected PDF layout metrics');
            }
            return layout;
        };
        // Fit width, then the fit-height replacement: every row shrinks, so the
        // pre-change scroll offset now sits several pages further down.
        const wideLayout = buildLayout(1);
        const shortLayout = buildLayout(0.25);
        let layout = wideLayout;
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(6),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 6} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 3),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 3),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 3,
                    end: 3,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            // getLayoutPageTop takes a zero-based row index.
            viewer.scrollTop = requireLayoutPageTop(wideLayout, 2) + 300;
            const scrolledAnchor = controller.captureCurrentSemanticAnchor();
            expect(scrolledAnchor?.page).toBe(3);
            controller.viewportAuthority.observeUserScroll(scrolledAnchor!);
            expect(controller.viewportAuthority.currentPage.value).toBe(3);

            layout = shortLayout;
            const fit = controller.submitViewportStateIntent('fit');
            expect(controller.viewportAuthority.activeIntent.value?.anchor?.page).toBe(3);
            await expect(fit).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 3},
            });
            // The viewport lands on page 3's row under the new metrics
            // instead of staying at the offset that now points past page 6.
            const settledTop = viewportWrites.writes.at(-1)?.top ?? -1;
            const pageThreeTop = requireLayoutPageTop(shortLayout, 2);
            expect(settledTop).toBeGreaterThanOrEqual(pageThreeTop - 20);
            expect(settledTop).toBeLessThan(pageThreeTop + 200);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it.each([
        'fit',
        'resize',
    ] as const)('keeps a resolved named-destination handoff through immediate %s absorption', async (kind) => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
        });
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        const metricPreparation = createDeferred();
        const visualPreparation = createDeferred();
        const freshPages = new Set([1]);
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();
        const requestedCurrentPage = ref<number | undefined>(1);
        const emittedCurrentPage = ref(1);
        const ensurePageMetricsInRange = vi.fn(async () => {
            await metricPreparation.promise;
            return false;
        });
        const prepareNavigationLayout = vi.fn(async () => undefined);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage: emittedCurrentPage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef(cast<IPdfDocument>({
                    numPages: 2,
                    getDestination: vi.fn(async () => null),
                    getPageIndex: vi.fn(async () => 1),
                    getPage: vi.fn(),
                })),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async (range) => {
                    await visualPreparation.promise;
                    freshPages.add(range.start);
                }),
                isPageFreshlyRenderedForNavigation: page => freshPages.has(page),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: page => {
                    emittedCurrentPage.value = page;
                    requestedCurrentPage.value = page;
                },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                ensurePageMetricsInRange,
                prepareNavigationLayout,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.submitNavigationRequest({
                target: {
                    kind: 'named-dest',
                    destination: [1],
                },
                alignment: 'page-top',
                readiness: 'page-canvas',
                source: 'bookmark',
                supersession: 'latest-wins',
            })).toBe(true);
            expect(controller.viewportAuthority.currentPage.value).toBe(1);

            const fit = controller.submitViewportStateIntent(kind, kind === 'resize' ? {anchor: {
                page: 1,
                pageXFraction: 0.5,
                pageYFraction: 0.7,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center',
            }} : {});
            expect(controller.viewportAuthority.activeIntent.value).toMatchObject({
                kind,
                navigation: {target: {
                    kind: 'named-dest',
                    destination: [1],
                }},
            });
            metricPreparation.resolve();

            await vi.waitFor(() => {
                expect(controller.viewportAuthority.getTerminalOutcome('viewport-navigation-1'))
                    .toBe('cancelled');
            });
            // The authority records cancellation before the detached task's
            // finally block runs. Cross a macrotask to prove that stale cleanup
            // cannot clear the fit intent's transferred handoff.
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(controller.navigationVisualHandoffTargetPage.value).toBe(2);
            visualPreparation.resolve();

            await expect(fit).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 2},
            });
            expect(controller.navigationVisualHandoffTargetPage.value).toBeNull();
            expect(viewportWrites.writes).toHaveLength(1);
            expect(prepareNavigationLayout).toHaveBeenCalledWith(
                2,
                expect.any(AbortSignal),
            );
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(emittedCurrentPage.value).toBe(2);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('prepares only the latest rapid navigation target before committing its viewport', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
        });
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        pageSlots.markMounted(3);
        const firstPreparation = createDeferred();
        const freshPages = new Set([1]);
        const prepareNavigationVisual = vi.fn(async (range: {
            start: number;
            end: number;
        }) => {
            if (range.start === 2) {
                await firstPreparation.promise;
            }
            const target = viewer.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            target?.querySelector('.document-page-skeleton')?.remove();
            const layer = document.createElement('div');
            layer.className = 'page_canvas';
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 800;
            layer.append(canvas);
            target?.append(layer);
            freshPages.add(range.start);
        });
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();
        const emitCurrentPage = vi.fn();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as IPdfDocument),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: prepareNavigationVisual,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(2)).toBe(true);
            await vi.waitFor(() => {
                expect(prepareNavigationVisual).toHaveBeenCalledWith(
                    {
                        start: 2,
                        end: 2,
                    },
                    {
                        authoritativeRaster: true,
                        preserveRenderedPages: true,
                        retainOnlyCurrentResidentRaster: true,
                        suppressResidentRasterDemand: false,
                    },
                );
            });
            expect(viewportWrites.writes).toHaveLength(0);
            expect(controller.viewportAuthority.currentPage.value).toBe(1);
            expect(controller.navigationState.value).toMatchObject({
                source: 'continuous',
                status: 'settling',
                targetPage: 2,
            });
            expect(viewer.querySelector('[data-page="1"] canvas')).not.toBeNull();
            expect(viewer.querySelector('[data-page="2"] .document-page-skeleton')).not.toBeNull();

            expect(controller.scrollToPage(3)).toBe(true);
            await vi.waitFor(() => {
                expect(viewportWrites.writes).toHaveLength(1);
            });
            expect(controller.viewportAuthority.currentPage.value).toBe(3);
            expect(controller.navigationState.value.status).toBe('idle');
            expect(freshPages.has(3)).toBe(true);
            expect(viewer.querySelector('[data-page="3"] .document-page-skeleton')).toBeNull();
            expect(viewer.querySelector('[data-page="3"] canvas')).not.toBeNull();

            firstPreparation.resolve();
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.getTerminalOutcome('viewport-navigation-1'))
                    .toBe('cancelled');
            });
            expect(viewportWrites.writes).toHaveLength(1);
            expect(emitCurrentPage).toHaveBeenLastCalledWith(3);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('preserves the latest pre-operational Next target across an early fit intent and replays it once', async () => {
        const scope = effectScope();
        const viewerRef = ref<HTMLElement | null>(null);
        const numPages = ref(0);
        const isLoading = ref(true);
        const pageSlots = createPdfPageSlotRegistry();
        const pdfDocument = shallowRef<IPdfDocument | null>(null);
        const viewportWrites = createTestPdfViewportWritePort();
        const navigationFeedback = vi.fn();
        const committedWorkspacePage = ref(1);
        const requestedCurrentPage = ref<number | undefined>(1);
        const freshPages = new Set<number>();
        const documentRevision = ref(0);
        const geometryRevision = ref(0);
        let layout: ReturnType<typeof buildPageLayoutMetrics> = null;
        const prepareNavigationVisual = vi.fn(async (range: {
            start: number;
            end: number
        }) => {
            const target = viewerRef.value?.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            target?.querySelector('.document-page-skeleton')?.remove();
            const layer = document.createElement('div');
            layer.className = 'page_canvas';
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 800;
            layer.append(canvas);
            target?.append(layer);
            freshPages.add(range.start);
        });

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: viewerRef,
                numPages,
                currentPage: committedWorkspacePage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading,
                pdfDocument,
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: prepareNavigationVisual,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: page => {
                    committedWorkspacePage.value = page;
                },
                emitNavigationFeedbackPage: navigationFeedback,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => documentRevision.value,
                getGeometryRevision: () => geometryRevision.value,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            // Explicit commands enter through the command API; the
            // requestedCurrentPage prop is a projection of the open surface
            // and must never be treated as the command channel.
            for (let requestedPage = 2; requestedPage <= 6; requestedPage += 1) {
                controller.scrollToPage(requestedPage);
                await nextTick();
            }
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(navigationFeedback).toHaveBeenLastCalledWith(6);
            expect(committedWorkspacePage.value).toBe(1);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);

            // A ResizeObserver callback can arrive during the same
            // pre-operational window while a split pane is mounting. It must
            // be ignored without rejecting into the renderer process.
            const staleResize = controller.submitViewportStateIntent('resize');
            await expect(staleResize).resolves.toMatchObject({outcome: 'cancelled'});

            const staleFit = controller.submitViewportStateIntent('fit');
            await expect(staleFit).resolves.toMatchObject({outcome: 'cancelled'});
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);

            // Loading flags briefly settle before the PDF document and page
            // count are published. That transient idle shape is not a session
            // close and must not erase the latest command.
            isLoading.value = false;
            await nextTick();
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(navigationFeedback).toHaveBeenLastCalledWith(6);

            const viewer = document.createElement('div');
            Object.defineProperties(viewer, {
                clientHeight: {value: 700},
                clientWidth: {value: 900},
            });
            for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
                const page = document.createElement('div');
                page.className = 'page_container';
                page.dataset.page = String(pageNumber);
                page.innerHTML = '<div class="document-page-skeleton"></div>';
                viewer.append(page);
            }
            layout = buildPageLayoutMetrics({
                pageMetrics: Array.from({length: 10}, () => ({
                    width: 600,
                    height: 800,
                })),
                totalPages: 10,
                viewMode: 'single',
                scale: 1,
                gap: 20,
                paddingTop: 20,
                paddingBottom: 20,
            });
            pageSlots.markMounted(6);
            viewerRef.value = viewer;
            numPages.value = 10;
            geometryRevision.value = 2;

            await nextTick();
            expect(viewportWrites.writes).toHaveLength(0);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();

            pdfDocument.value = {numPages: 10} as IPdfDocument;
            documentRevision.value = 2;
            isLoading.value = false;

            await vi.waitFor(() => {
                expect(viewportWrites.writes).toHaveLength(1);
            });
            expect(prepareNavigationVisual).toHaveBeenCalledOnce();
            expect(prepareNavigationVisual).toHaveBeenCalledWith(
                {
                    start: 6,
                    end: 6,
                },
                {
                    authoritativeRaster: true,
                    preserveRenderedPages: true,
                    retainOnlyCurrentResidentRaster: true,
                    suppressResidentRasterDemand: false,
                },
            );
            expect(controller.viewportAuthority.currentPage.value).toBe(6);
            expect(committedWorkspacePage.value).toBe(6);
            expect(viewportWrites.writes[0]?.top).toBeGreaterThan(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('cancels a queued pre-metadata target only through an explicit lifecycle command', async () => {
        const scope = effectScope();
        const viewerRef = ref<HTMLElement | null>(null);
        const numPages = ref(0);
        const isLoading = ref(true);
        const pageSlots = createPdfPageSlotRegistry();
        const viewportWrites = createTestPdfViewportWritePort();
        const navigationFeedback = vi.fn();
        const prepareNavigationVisual = vi.fn(async () => undefined);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: viewerRef,
                numPages,
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading,
                pdfDocument: shallowRef(null),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                emitNavigationFeedbackPage: navigationFeedback,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => null,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(5)).toBe(true);
            expect(controller.navigationAnchorPage.value).toBe(5);
            isLoading.value = false;
            await nextTick();

            expect(controller.navigationAnchorPage.value).toBe(5);
            expect(navigationFeedback).toHaveBeenLastCalledWith(5);

            controller.cancelDestinationNavigationTarget();
            expect(controller.navigationAnchorPage.value).toBeNull();
            expect(navigationFeedback).toHaveBeenLastCalledWith(null);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });
});
