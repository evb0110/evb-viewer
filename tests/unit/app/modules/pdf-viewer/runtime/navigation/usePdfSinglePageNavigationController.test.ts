import type { Ref } from 'vue';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    effectScope,
    h,
    nextTick,
    queuePostFlushCb,
    ref,
    shallowRef,
    watch,
} from 'vue';
import {
    buildPageLayoutMetrics,
    createPageNavigationRequest,
    createPdfViewportGeometryFromLayout,
    getLayoutPageTop,
    resolveScrollForAnchor,
    type IPdfPageLayoutMetrics,
    type IPdfSemanticAnchor,
} from '@app/modules/document-viewer/public';
import {BrowserLogger} from '@app/utils/browserLogger';
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
        let pageIndicator: Readonly<Ref<number>> = ref(1);

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
                updateVisibleRange: vi.fn(),
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
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;

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
        let targetTop = 2_400;
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
            page.getBoundingClientRect = () => {
                const contentTop = pageNumber === 1 ? 20 : targetTop;
                return ({
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
            };
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
        let pageIndicator: Readonly<Ref<number>> = ref(1);

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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;
            // Ending the handoff lays the outgoing page the virtual window held
            // out at the current scale, which moves the target.
            const released: boolean[] = [];
            const stop = watch(controller.navigationAnchorPage, (page) => {
                if (page !== null) return;
                released.push(controller.isProgrammaticNavigationActive.value);
                targetTop = 2_700;
            }, {flush: 'sync'});

            expect(controller.scrollToPage(requirePageNumber(2))).toBe(true);
            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(2);
            });
            expect(requireLayoutPageTop(layout, 1)).toBeLessThan(1_000);
            await vi.waitFor(() => expect(controller.isProgrammaticNavigationActive.value).toBe(false));
            // The handoff ends while the navigation still runs, and it places
            // its page through the released layout before it settles.
            expect(released).toEqual([true]);
            expect(viewportWrites.writes.map(write => write.top)).toEqual([
                2_380,
                2_680,
            ]);
            await nextTick();
            expect(viewer.scrollTop).toBe(2_680);
            expect(pageIndicator.value).toBe(2);
            stop();
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
        let pageIndicator: Readonly<Ref<number>> = ref(1);

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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;

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
        let pageIndicator: Readonly<Ref<number>> = ref(1);

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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;

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
        let pageIndicator: Readonly<Ref<number>> = ref(1);
        let navigationTargetPage: Readonly<Ref<number | null>> = ref(null);
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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                prepareNavigationLayout: async () => preparation.promise,
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;
            navigationTargetPage = controller.navigationAnchorPage;

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
            expect(navigationTargetPage.value).toBe(4);
            expect(preventDefault).toHaveBeenCalledTimes(3);
            await yieldToBrowser();
            expect(pageIndicator.value).toBe(1);
            expect(viewportWrites.writes).toHaveLength(0);

            preparation.resolve();
            await vi.waitFor(() => {
                expect(pageIndicator.value).toBe(4);
                expect(navigationTargetPage.value).toBeNull();
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

    it('flips by one page on a small smooth scroll with mid-gesture diagonal jitter', async () => {
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
            page.innerHTML = '<div class="page_canvas"><canvas width="500" height="660"></canvas></div>';
            Object.defineProperties(page, {
                offsetHeight: {value: 660},
                offsetTop: {value: 20},
            });
            viewer.append(page);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 5}, () => ({
                width: 500,
                height: 660,
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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            // First packet flips from page 1 to page 2 and settles.
            expect(controller.handleWheel({
                timeStamp: 1_000,
                deltaX: 0,
                deltaY: 36,
                cancelable: true,
                preventDefault,
            })).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });

            // Remaining decaying tail (> 180ms cooldown) plus mid-gesture horizontal jitter stays on page 2.
            for (const packet of [
                {timeStamp: 1_020, deltaX: 12, deltaY: 2},
                {timeStamp: 1_040, deltaX: 0, deltaY: 28},
                {timeStamp: 1_120, deltaX: 0, deltaY: 16},
                {timeStamp: 1_200, deltaX: 0, deltaY: 8},
                {timeStamp: 1_280, deltaX: 0, deltaY: 4},
                {timeStamp: 1_360, deltaX: 0, deltaY: 2},
            ]) {
                expect(controller.handleWheel({
                    ...packet,
                    cancelable: true,
                    preventDefault,
                })).toBe(true);
            }
            await yieldToBrowser();
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            expect(preventDefault).toHaveBeenCalledTimes(7);

            // After a quiet gap (>= 200ms), another small scroll flips to page 3.
            expect(controller.handleWheel({
                timeStamp: 1_600,
                deltaX: 0,
                deltaY: 36,
                cancelable: true,
                preventDefault,
            })).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });
        } finally {
            scope.stop();
        }
    });

    it('ignores horizontal-dominant line-mode wheel input and advances repeated 1-line notches', async () => {
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
        for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="500" height="660"></canvas></div>';
            Object.defineProperties(page, {
                offsetHeight: {value: 660},
                offsetTop: {value: 20},
            });
            viewer.append(page);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 10}, () => ({
                width: 500,
                height: 660,
            })),
            totalPages: 10,
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
                numPages: ref(10),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(false),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 10} as IPdfDocument),
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            // Line mode horizontal-dominant packet: deltaX=2 lines, deltaY=1 line -> deltaPx=16.
            const horizontalPrevent = vi.fn();
            expect(controller.handleWheel({
                cancelable: true,
                deltaMode: 1,
                deltaX: 2,
                deltaY: 1,
                timeStamp: 100,
                preventDefault: horizontalPrevent,
            }, 16)).toBe(false);
            expect(horizontalPrevent).not.toHaveBeenCalled();
            expect(controller.viewportAuthority.currentPage.value).toBe(1);

            // Sixteen 1-line vertical notches spaced 100ms apart turn multiple pages.
            for (let index = 0; index < 16; index += 1) {
                controller.handleWheel({
                    cancelable: true,
                    deltaMode: 1,
                    deltaX: 0,
                    deltaY: 1,
                    timeStamp: 500 + index * 100,
                    preventDefault: vi.fn(),
                }, 16);
                await yieldToBrowser();
            }
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBeGreaterThanOrEqual(6);
            });
        } finally {
            scope.stop();
        }
    });

    it('keeps a cancelable tail fenced across a >200ms gap while the viewport write port reports an open host sequence', async () => {
        const {
            createDocumentViewportWritePort,
            observeDocumentViewportWheelInteraction,
        } = await import('@app/modules/document-viewer/runtime/documentViewportWritePort');
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 1_040},
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
            page.innerHTML = '<div class="page_canvas"><canvas width="500" height="1000"></canvas></div>';
            Object.defineProperties(page, {
                offsetHeight: {value: 1_000},
                offsetTop: {value: 20},
            });
            viewer.append(page);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 5}, () => ({
                width: 500,
                height: 1_000,
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
        const port = createDocumentViewportWritePort();

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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                viewportWritePort: port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            const makeEvent = (timeStamp: number, deltaY: number) => {
                const event = {
                    cancelable: true,
                    clientX: 100,
                    clientY: 100,
                    defaultPrevented: false,
                    deltaMode: 0,
                    deltaX: 0,
                    deltaY,
                    timeStamp,
                    preventDefault: vi.fn(() => {
                        event.defaultPrevented = true;
                    }),
                };
                return event;
            };

            // 1. Interior scroll starts the host sequence unprevented.
            const interiorEvent = makeEvent(0, 40);
            observeDocumentViewportWheelInteraction(port, {
                deltaPx: 40,
                event: interiorEvent,
                intent: 'scroll',
            }, viewer);
            expect(controller.handleWheel(interiorEvent, 40)).toBe(false);
            port.observeWheelScrollSequence('begin');

            // 2. Reaching the bottom edge flips once to page 2.
            viewer.scrollTop = 340;
            const flipEvent = makeEvent(40, 120);
            observeDocumentViewportWheelInteraction(port, {
                deltaPx: 120,
                event: flipEvent,
                intent: 'scroll',
            }, viewer);
            expect(controller.handleWheel(flipEvent, 120)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(2);
                expect(controller.isProgrammaticNavigationActive.value).toBe(false);
            });

            // 3. A cancelable decaying tail after a 260ms gap stays blocked while the host sequence is open.
            viewer.scrollTop = 340;
            const delayedTailEvent = makeEvent(300, 60);
            observeDocumentViewportWheelInteraction(port, {
                deltaPx: 60,
                event: delayedTailEvent,
                intent: 'scroll',
            }, viewer);
            expect(controller.handleWheel(delayedTailEvent, 60)).toBe(true);
            await yieldToBrowser();
            expect(controller.viewportAuthority.currentPage.value).toBe(2);

            // 4. After the host ends the sequence and a quiet gap passes, a new gesture flips to page 3.
            port.observeWheelScrollSequence('end');
            const nextGestureEvent = makeEvent(560, 120);
            observeDocumentViewportWheelInteraction(port, {
                deltaPx: 120,
                event: nextGestureEvent,
                intent: 'scroll',
            }, viewer);
            expect(controller.handleWheel(nextGestureEvent, 120)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
            });
        } finally {
            scope.stop();
        }
    });

    it.each([
        0,
        1,
        2,
        3,
        4,
        -1,
    ])('keeps the reading point through a fit or %i quarter turns before one flush', async (turns) => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 50_000},
            scrollWidth: {value: 5_000},
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
        const buildLayout = (scale: number, rotated = false) => {
            const layout = buildPageLayoutMetrics({
                pageMetrics: Array.from({length: 6}, () => ({
                    width: rotated ? 2_400 : 600,
                    height: rotated ? 600 : 2_400,
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
        const wideLayout = buildLayout(2);
        const targetLayout = buildLayout(turns === 0 ? 1.4 : 2, Math.abs(turns) % 2 === 1);
        let layout = wideLayout;
        const viewportWrites = createTestPdfViewportWritePort();
        let pageIndicator: Readonly<Ref<number>> = ref(1);

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
                updateVisibleRange: vi.fn(),
                renderVisiblePages: vi.fn(async () => true),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 3,
                    end: 3,
                }),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                getPhysicalScrollOrigin: () => 0,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }
            pageIndicator = controller.viewportAuthority.currentPage;

            // The user scrolls into page 3. getLayoutPageTop takes a
            // zero-based row index.
            viewer.scrollTop = requireLayoutPageTop(wideLayout, 2) + 1_000;
            viewer.scrollLeft = 170;
            controller.cancelProgrammaticNavigation('viewer-scroll-interaction');
            await nextTick();
            expect(pageIndicator.value).toBe(3);

            const before = controller.captureRelayoutAnchor()!;
            let expectedX = before.pageXFraction;
            let expectedY = before.pageYFraction;
            const receipts: Array<Promise<unknown>> = [];
            if (turns === 0) {
                receipts.push(controller.relayout(() => { layout = targetLayout; }));
            }
            for (let step = 0; step < Math.abs(turns); step += 1) {
                [
                    expectedX,
                    expectedY,
                ] = turns > 0 ? [
                    1 - expectedY,
                    expectedX,
                ] : [
                    expectedY,
                    1 - expectedX,
                ];
                receipts.push(controller.relayout(() => { layout = targetLayout; }, anchor => ({
                    ...anchor,
                    pageXFraction: turns > 0 ? 1 - anchor.pageYFraction : anchor.pageYFraction,
                    pageYFraction: turns > 0 ? anchor.pageXFraction : 1 - anchor.pageXFraction,
                })));
            }
            const answered: unknown[] = [];
            for (const receipt of receipts) void receipt.then(result => answered.push(result));
            const writesBefore = viewportWrites.writes.length;
            await nextTick();
            // Every change of the flush is answered by its one placement, in
            // that flush, before the browser paints the new layout.
            expect(viewportWrites.writes).toHaveLength(writesBefore + 1);
            expect(answered).toHaveLength(receipts.length);
            expect(new Set(answered).size).toBe(1);
            expect(answered[0]).toMatchObject({
                outcome: 'placed',
                commit: {
                    intentKind: 'relayout',
                    page: 3,
                    top: viewer.scrollTop,
                },
            });
            expect(pageIndicator.value).toBe(3);
            const targetWidth = (Math.abs(turns) % 2 === 1 ? 2_400 : 600) * targetLayout.scale;
            const targetHeight = (Math.abs(turns) % 2 === 1 ? 600 : 2_400) * targetLayout.scale;
            expect(viewer.scrollTop).toBeCloseTo(requireLayoutPageTop(targetLayout, 2) + expectedY * targetHeight - 350);
            expect(viewer.scrollLeft).toBeCloseTo(Math.max(0, 20 + expectedX * targetWidth - 450));
            // View/scroll mode may still explicitly request page-top placement.
            controller.relayout(undefined, getRequestAnchor(undefined, 3));
            await nextTick();
            expect(viewer.scrollTop).toBe(requireLayoutPageTop(targetLayout, 2) - 20);
        } finally {
            scope.stop();
        }
    });

    it.each([
        {
            cause: 'reader input',
            outcome: 'superseded',
        },
        {
            cause: 'a newer navigation',
            outcome: 'superseded',
        },
        {
            cause: 'the document closing',
            outcome: 'cancelled',
        },
        {
            cause: 'a document revision',
            outcome: 'cancelled',
        },
        {
            cause: 'the view closing',
            outcome: 'cancelled',
        },
    ] as const)('answers a layout change that $cause took over before its flush without placing it', async ({
        cause,
        outcome,
    }) => {
        const view = createRelayoutView();
        try {
            await view.readAt(1_200);
            const writesBefore = view.writes.length;

            const receipt = view.controller.relayout(() => view.setScale(1.5));
            if (cause === 'reader input') {
                view.port.observeUserInteraction(view.viewer);
            } else if (cause === 'a newer navigation') {
                view.controller.scrollToPage(requirePageNumber(5));
            } else if (cause === 'the document closing') {
                view.isLoading.value = true;
            } else if (cause === 'a document revision') {
                view.documentRevision.value += 1;
            } else {
                view.scope.stop();
            }

            await expect(receipt).resolves.toEqual({outcome});
            expect(view.writes.slice(writesBefore).map(write => write.reason)).not.toContain('relayout');
            if (cause === 'reader input') expect(view.viewer.scrollTop).toBe(1_200);
        } finally {
            view.dispose();
        }
    });

    it('starts a layout change afresh from the reader\'s point once the reader moved', async () => {
        const view = createRelayoutView();
        try {
            await view.readAt(1_200);
            // A resize is pending when a pinch starts on page 4.
            const resize = view.controller.relayout(() => view.setScale(1.2));
            view.port.observeUserInteraction(view.viewer);
            const pinchPoint = {
                page: 4,
                pageXFraction: 0.25,
                pageYFraction: 0.6,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center' as const,
            };
            const pinch = view.controller.relayout(undefined, pinchPoint);

            await expect(resize).resolves.toEqual({outcome: 'superseded'});
            await expect(pinch).resolves.toMatchObject({outcome: 'placed'});
            expect(view.controller.viewportAuthority.committedAnchor.value).toMatchObject(pinchPoint);
            expect(view.viewer.scrollTop).toBeCloseTo(view.scrollFor(pinchPoint).top, 0);
        } finally {
            view.dispose();
        }
    });

    it('leaves an admitted reload to place its own point, and places freely after it did', async () => {
        const view = createRelayoutView();
        try {
            await view.readAt(1_200);
            const {viewportAuthority} = view.controller;
            viewportAuthority.beginWork('reload', 2);
            const writesBefore = view.writes.length;

            await expect(view.controller.relayout(() => view.setScale(1.5))).resolves.toEqual({outcome: 'superseded'});
            expect(view.writes).toHaveLength(writesBefore);

            expect(view.controller.place(getRequestAnchor(undefined, 2), 'document-restore')).toBe(true);
            await expect(view.controller.relayout(() => view.setScale(1))).resolves.toMatchObject({outcome: 'placed'});
        } finally {
            view.dispose();
        }
    });

    it('commits nothing when the view refuses a write', async () => {
        const view = createRelayoutView({refuseWrites: true});
        try {
            await view.readAt(1_200);
            await expect(view.controller.relayout(() => view.setScale(1.5))).resolves.toEqual({outcome: 'cancelled'});
            expect(view.controller.scrollToPage(requirePageNumber(5))).toBe(true);
            await vi.waitFor(() => expect(view.controller.isProgrammaticNavigationActive.value).toBe(false));
            expect(view.controller.viewportAuthority.currentPage.value).toBe(2);
            expect(view.committed).toEqual([]);
        } finally {
            view.dispose();
        }
    });

    it('turns the shown point with its page while a staged navigation waits for its raster', async () => {
        const raster = createDeferred();
        const view = createRelayoutView({
            renderVisiblePages: async () => {
                await raster.promise;
                return true;
            },
            freshPages: new Set([1, 2, 3, 4]),
        });
        try {
            const shown = {
                page: 3,
                pageXFraction: 0.2,
                pageYFraction: 0.3,
                viewportXFraction: 0.5,
                viewportYFraction: 0.5,
                affinity: 'center' as const,
            };
            view.controller.cancelProgrammaticNavigation('viewer-scroll-interaction', shown);
            // A ticketless navigation stages: it places only once its raster is ready.
            expect(view.controller.scrollToPage(requirePageNumber(6))).toBe(true);
            await vi.waitFor(() => expect(view.controller.viewportAuthority.phase.value).toBe('awaiting-visual'));

            const turned = {
                ...shown,
                pageXFraction: 1 - shown.pageYFraction,
                pageYFraction: shown.pageXFraction,
            };
            await expect(view.controller.relayout(() => view.setScale(1, true), anchor => ({
                ...anchor,
                pageXFraction: 1 - anchor.pageYFraction,
                pageYFraction: anchor.pageXFraction,
            }))).resolves.toEqual({outcome: 'superseded'});
            expect(view.controller.viewportAuthority.committedAnchor.value).toMatchObject(turned);
            expect(view.viewer.scrollTop).toBeCloseTo(view.scrollFor(turned).top, 0);
            expect(view.viewer.scrollLeft).toBeCloseTo(view.scrollFor(turned).left, 0);
        } finally {
            raster.resolve();
            view.dispose();
        }
    });

    it('places a layout change made inside a post flush against the layout Vue patched for it', async () => {
        const view = createRelayoutView({renderedScale: true});
        const trigger = ref(0);
        try {
            await view.readAt(1_200);
            const placedAtScale: string[] = [];
            view.onVisibleRangeUpdate(() => placedAtScale.push(view.renderedScale()));
            const stop = watch(trigger, () => {
                view.controller.relayout(() => view.setScale(2));
            }, {flush: 'post'});
            trigger.value += 1;
            const receipt = view.controller.relayout();

            await expect(receipt).resolves.toMatchObject({outcome: 'placed'});
            expect(placedAtScale).toEqual(['2']);
            stop();
        } finally {
            view.dispose();
        }
    });

    it('answers a layout change whose placement throws without stranding other post-flush work', async () => {
        const errors = vi.spyOn(BrowserLogger, 'error');
        const view = createRelayoutView();
        try {
            await view.readAt(1_200);
            const receipt = view.controller.relayout(() => view.setScale(1.5));
            view.onVisibleRangeUpdate(() => {
                throw new Error('visible range projection failed');
            });
            const sibling = vi.fn();
            queuePostFlushCb(sibling);

            await expect(receipt).resolves.toEqual({outcome: 'cancelled'});
            await nextTick();
            expect(sibling).toHaveBeenCalledOnce();
            expect(errors).toHaveBeenCalledOnce();
        } finally {
            errors.mockRestore();
            view.dispose();
        }
    });
});

/**
 * Six 600x800 pages in continuous scroll, whose layout scale and rotation the
 * test changes, behind a recording write port.
 */
function createRelayoutView(input: {
    refuseWrites?: boolean;
    renderVisiblePages?: () => Promise<boolean>;
    freshPages?: Set<number>;
    /** The scale comes from a Vue-rendered element, read when the layout is. */
    renderedScale?: boolean;
} = {}) {
    const scope = effectScope();
    const viewer = document.createElement('div');
    Object.defineProperties(viewer, {
        clientHeight: {value: 700},
        clientWidth: {value: 900},
        scrollHeight: {value: 50_000},
        scrollWidth: {value: 5_000},
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
    const scale = ref(1);
    let rotated = false;
    const root = document.createElement('div');
    const app = input.renderedScale
        ? createApp({render: () => h('div', {'data-scale': String(scale.value)})})
        : null;
    app?.mount(root);
    const renderedScale = () => (root.firstElementChild as HTMLElement | null)?.dataset.scale ?? String(scale.value);
    const buildLayout = () => {
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 6}, () => ({
                width: rotated ? 800 : 600,
                height: rotated ? 600 : 800,
            })),
            totalPages: 6,
            viewMode: 'single',
            scale: Number(renderedScale()),
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        if (!layout) throw new Error('Expected PDF layout metrics');
        return layout;
    };
    const isLoading = ref(false);
    const documentRevision = ref(1);
    const viewportWrites = createTestPdfViewportWritePort();
    const port = input.refuseWrites ? {
        ...viewportWrites.port,
        apply: () => false,
    } : viewportWrites.port;
    const committed: unknown[] = [];
    let onVisibleRangeUpdate = () => {};
    const freshPages = input.freshPages;
    const controller = scope.run(() => usePdfSinglePageNavigationController({
        viewerContainer: ref(viewer),
        numPages: ref(6),
        currentPage: ref(1),
        scaledMargin: ref(20),
        viewMode: ref('single'),
        continuousScroll: ref(true),
        isLoading,
        pdfDocument: shallowRef({numPages: 6} as IPdfDocument),
        updateVisibleRange: () => onVisibleRangeUpdate(),
        renderVisiblePages: input.renderVisiblePages ?? (async () => true),
        isPageFreshlyRenderedForNavigation: page => freshPages?.has(page) ?? true,
        visibleRange: ref({
            start: 2,
            end: 2,
        }),
        viewportWritePort: port,
        getPageLayoutMetrics: buildLayout,
        getPhysicalScrollOrigin: () => 0,
        getDocumentRevision: () => documentRevision.value,
        getGeometryRevision: () => 1,
        onViewportPositionCommitted: (commit) => {
            committed.push(commit);
            return true;
        },
    }));
    if (!controller) throw new Error('Expected navigation controller');
    return {
        scope,
        viewer,
        controller,
        port: viewportWrites.port,
        writes: viewportWrites.writes,
        committed,
        isLoading,
        documentRevision,
        renderedScale,
        setScale(next: number, turn = false) {
            scale.value = next;
            if (turn) rotated = !rotated;
        },
        onVisibleRangeUpdate(callback: () => void) {
            onVisibleRangeUpdate = callback;
        },
        /** The reader scrolls the view to this offset. */
        async readAt(top: number) {
            viewer.scrollTop = top;
            controller.cancelProgrammaticNavigation('viewer-scroll-interaction');
            await nextTick();
        },
        scrollFor(anchor: IPdfSemanticAnchor) {
            return resolveScrollForAnchor(createPdfViewportGeometryFromLayout(buildLayout(), {
                width: 900,
                height: 700,
                paddingInline: 20,
            }, 1, 0), anchor);
        },
        dispose() {
            scope.stop();
            app?.unmount();
        },
    };
}
