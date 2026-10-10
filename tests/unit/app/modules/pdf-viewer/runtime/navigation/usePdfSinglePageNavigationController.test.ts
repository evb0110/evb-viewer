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
import {
    buildPageLayoutMetrics,
    createPageNavigationRequest,
    getLayoutPageTop,
    type IPdfPageLayoutMetrics,
} from '@app/modules/document-viewer/public';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { getRequestAnchor } from '@app/modules/pdf-viewer/runtime/navigation/pdfNavigationRequestAnchors';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
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
    it('lands a search result once the layer its readiness names is ready', async () => {
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
        const pages = new Map<number, HTMLElement>();
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
            pages.set(pageNumber, page);
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
        // The renderer paints a canvas; a page's text layer is built later and
        // reports ready only when this test builds it.
        const textLayerBuilt = createDeferred();
        const viewportWrites = createTestPdfViewportWritePort();
        const pageIndicator = ref(1);

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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: async (range) => {
                    pages.get(range.start)!.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
                    freshPages.add(range.start);
                    return true;
                },
                waitForPageTextLayerReady: async () => {
                    await textLayerBuilt.promise;
                    return true;
                },
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
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
            // A canvas-ready result lands without its text layer.
            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(2);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });
            expect(pages.get(2)!.querySelector('canvas')).not.toBeNull();

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
                source: 'search',
                supersession: 'latest-wins',
            })).toBe(true);
            // A result that needs its text layer for the highlight is still
            // navigating once its canvas is painted.
            await vi.waitFor(() => {
                expect(pages.get(3)!.querySelector('canvas')).not.toBeNull();
            });
            await yieldToBrowser();
            expect(controller.isProgrammaticNavigationActive.value).toBe(true);

            pages.get(3)!.insertAdjacentHTML('beforeend', '<div class="text-layer" data-pdf-text-layer-ready="true"></div>');
            textLayerBuilt.resolve();
            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(3);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });
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
        const pageIndicator = ref(1);

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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
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
                expect(pageIndicator.value).toBe(2);
            });
            expect(requireLayoutPageTop(layout, 1)).toBeLessThan(1_000);
            expect(viewportWrites.writes.at(-1)?.top).toBe(2_380);
            expect(viewer.scrollTop).toBe(2_380);
        } finally {
            scope.stop();
        }
    });

    it.each([
        {
            viewportWidth: 1_604,
            pageWidth: 1_532,
            expectedLeft: 0,
        },
        {
            viewportWidth: 885,
            pageWidth: 857,
            expectedLeft: 6,
        },
    ])('restores the reading centre with $viewportWidth px of viewport and $pageWidth px of paper', async ({
        viewportWidth, pageWidth, expectedLeft,
    }) => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: viewportWidth},
            scrollHeight: {value: 4_000},
            scrollWidth: {value: Math.max(2_200, pageWidth + 40)},
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
            right: viewportWidth,
            top: 0,
            width: viewportWidth,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        });
        const target = document.createElement('div');
        target.className = 'page_container page_container--rendered';
        target.dataset.page = '2';
        target.innerHTML = `<div class="page_canvas"><canvas width="${String(pageWidth)}" height="800"></canvas></div>`;
        const pageLeft = Math.max(20, (viewportWidth - pageWidth) / 2);
        target.getBoundingClientRect = () => ({
            bottom: 1_700 - viewer.scrollTop,
            height: 800,
            left: pageLeft - viewer.scrollLeft,
            right: pageLeft + pageWidth - viewer.scrollLeft,
            top: 900 - viewer.scrollTop,
            width: pageWidth,
            x: pageLeft - viewer.scrollLeft,
            y: 900 - viewer.scrollTop,
            toJSON: () => ({}),
        });
        viewer.append(target);
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: pageWidth,
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
        const pageIndicator = ref(1);

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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.submitNavigationRequest(createPageNavigationRequest(2, 'restore', {
                page: 2,
                pageXFraction: 0.5,
                pageYFraction: 0.425,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center',
            }))).toBe(true);

            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(2);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });
            expect(viewer.scrollTop).toBe(890);
            expect(viewer.scrollLeft).toBe(expectedLeft);
            const restoredPaperPoint = (viewportWidth / 2 - target.getBoundingClientRect().left) / pageWidth;
            expect(restoredPaperPoint).toBe(0.5);
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
        const pageIndicator = ref(1);

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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
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
                expect(pageIndicator.value).toBe(3);
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
        const pageIndicator = ref(1);
        const navigationFeedbackPage = ref<number | null>(null);
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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => true),
                prepareNavigationLayout: async () => preparation.promise,
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
                emitNavigationFeedbackPage: (page) => {
                    navigationFeedbackPage.value = page;
                },
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
            // Three flips are acknowledged as one destination while the
            // viewport waits on page 1 for the layout.
            expect(navigationFeedbackPage.value).toBe(4);
            expect(preventDefault).toHaveBeenCalledTimes(3);
            await yieldToBrowser();
            expect(pageIndicator.value).toBe(1);
            expect(viewportWrites.writes).toHaveLength(0);

            preparation.resolve();
            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(4);
                expect(navigationFeedbackPage.value).toBeNull();
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

    it('relayouts a fit change on the page the user scrolled to, not on the reinterpreted offset', async () => {
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
        const pageIndicator = ref(1);

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
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 3),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 3,
                    end: 3,
                }),
                emitCurrentPage: (page) => {
                    pageIndicator.value = page;
                },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                cancelPendingSearchScroll: vi.fn(),
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            // The user scrolls into page 3. getLayoutPageTop takes a
            // zero-based row index.
            viewer.scrollTop = requireLayoutPageTop(wideLayout, 2) + 300;
            controller.cancelProgrammaticNavigation('viewer-scroll-interaction');
            await nextTick();
            expect(pageIndicator.value).toBe(3);

            // A fit change keeps the top of the page the indicator names.
            controller.relayout(() => {
                layout = shortLayout;
            }, getRequestAnchor(undefined, pageIndicator.value));
            await nextTick();
            expect(pageIndicator.value).toBe(3);
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
});
