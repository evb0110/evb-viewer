import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { getLayoutPageTop } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import type { IPdfPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/pdfPageLayoutMetrics';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';
import {
    requirePageIndex,
    requirePageNumber,
} from '@contracts/pageNumbers';

function requireLayoutPageTop(layout: IPdfPageLayoutMetrics, pageIndex: number) {
    const top = getLayoutPageTop(layout, requirePageIndex(pageIndex));
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
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
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
            return true;
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
                cancelPendingSearchScroll: vi.fn(),
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
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(requirePageNumber(2))).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
            });
            expect(requireLayoutPageTop(layout, 1)).toBeLessThan(1_000);
            expect(viewportWrites.writes.at(-1)?.top).toBe(2_380);
            expect(viewer.scrollTop).toBe(2_380);
        } finally {
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
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
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
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
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
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(requirePageNumber(3))).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
            });
            expect(getLayoutPageTop(layout, requirePageIndex(2))).toBeGreaterThan(viewer.scrollHeight);
            expect(viewportWrites.writes.at(-1)?.top).toBe(0);
            expect(viewer.scrollTop).toBe(0);
        } finally {
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
        for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
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
                renderVisiblePages: vi.fn(async () => true),
                prepareNavigationLayout: async () => preparation.promise,
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
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
        } finally {
            scope.stop();
        }
    });

    it('anchors zoom to the viewport authority page while the outer requested page lags', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        let viewportHeight = 700;
        Object.defineProperties(viewer, {
            clientHeight: {get: () => viewportHeight},
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
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 2,
                }),
                emitCurrentPage: page => { currentPage.value = page; },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
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
            viewer.getBoundingClientRect = () => new DOMRect(0, 0, 900, 700);
            const mountedPage = viewer.querySelector<HTMLElement>('[data-page="2"]')!;
            mountedPage.dataset.documentPageNumber = '2';
            mountedPage.getBoundingClientRect = () => new DOMRect(150, -200, 600, 1_600);
            const livePageTwoAnchor = controller.captureCurrentSemanticAnchor();
            expect(livePageTwoAnchor?.pageYFraction).toBe(550 / 1_600);
            expect(livePageTwoAnchor?.page).toBe(2);
            controller.viewportAuthority.observeUserScroll(livePageTwoAnchor!);
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
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
            const cursorZoom = controller.submitViewportStateIntent('zoom', {
                zoom: 6,
                viewportPoint: {
                    x: 300,
                    y: 500,
                },
            });
            // Admitting a horizontal scrollbar changes the usable height
            // after capture; the cursor must keep its absolute screen point.
            viewportHeight = 650;
            await expect(cursorZoom).resolves.toMatchObject({outcome: 'settled'});
            expect(controller.viewportAuthority.committedAnchor.value).toMatchObject({
                page: 2,
                pageXFraction: 0.25,
                pageYFraction: 700 / 1_600,
                viewportYFraction: 500 / 650,
            });
        } finally {
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
        for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
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
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 3,
                    end: 3,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
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
            scope.stop();
        }
    });

    it.each([
        'during-raster',
        'after-write',
    ] as const)('cancels cleanly when the document closes %s', async (closeAt) => {
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
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
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
        const numPages = ref(3);
        const pdfDocument = shallowRef<IPdfDocument | null>({numPages: 3} as IPdfDocument);
        let ambient = false;
        const closeDocument = () => {
            numPages.value = 0;
            pdfDocument.value = null;
        };
        const documentRevision = ref(1);
        const freshPages = new Set([1]);
        const isPageFreshlyRenderedForNavigation = vi.fn((pageNumber: number) => freshPages.has(pageNumber));
        const viewportWrites = createTestPdfViewportWritePort();
        const renderVisiblePages = vi.fn(async (range: {
            start: number;
            end: number
        }) => {
            if (renderVisiblePages.mock.calls.length === 1) {
                freshPages.add(range.start);
                return true;
            }
            // Closing the file tears the document down while the target
            // raster is still awaited: no live page range remains.
            if (closeAt === 'during-raster') {
                closeDocument();
                documentRevision.value += 1;
            }
            return true;
        });
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (event: PromiseRejectionEvent) => {
            unhandledRejections.push(event.reason);
        };
        window.addEventListener('unhandledrejection', onUnhandledRejection);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages,
                currentPage: ref(2),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument,
                getMostVisiblePage: vi.fn(() => 2),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: () => {
                    if (ambient && closeAt === 'after-write') closeDocument();
                },
                updateCurrentPage: vi.fn(() => 2),
                renderVisiblePages,
                isPageFreshlyRenderedForNavigation,
                visibleRange: ref({
                    start: 2,
                    end: 2,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
                getDocumentRevision: () => documentRevision.value,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            controller.scrollToPage(requirePageNumber(2));
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
                expect(controller.viewportAuthority.activeIntent.value).toBeNull();
            });
            expect(renderVisiblePages).toHaveBeenCalledTimes(1);
            // A zoom change invalidates the committed raster of page 2.
            freshPages.delete(2);
            ambient = true;

            // Ambient zoom/fit/activation intents are fire-and-forget: a
            // rejection here surfaces as an unhandled promise rejection.
            await expect(controller.submitViewportStateIntent('zoom', {zoom: 2})).resolves.toMatchObject({outcome: 'cancelled'});
            expect(renderVisiblePages).toHaveBeenCalledTimes(closeAt === 'during-raster' ? 2 : 1);
            await nextTick();

            expect(controller.viewportAuthority.phase.value).toBe('cancelled');
            expect(unhandledRejections).toEqual([]);
            // The freshness probe must never receive a page the closed
            // document cannot validate.
            for (const [pageNumber] of isPageFreshlyRenderedForNavigation.mock.calls) {
                expect(pageNumber).toBeGreaterThanOrEqual(1);
                expect(pageNumber).toBeLessThanOrEqual(3);
            }
        } finally {
            window.removeEventListener('unhandledrejection', onUnhandledRejection);
            scope.stop();
        }
    });
});
