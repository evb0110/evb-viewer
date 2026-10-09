import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfScroll as usePdfScrollProduction } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import {
    buildPageLayoutMetrics,
    PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT,
} from '@app/modules/document-viewer/public';
import {getPageTop} from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageTop';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

const usePdfScroll = (
    options: Omit<Parameters<typeof usePdfScrollProduction>[0], 'viewportWritePort'> = {},
) => usePdfScrollProduction({
    ...options,
    viewportWritePort: createTestPdfViewportWritePort().port,
});

function createElementShim(shape: Record<string, unknown>): HTMLElement {
    // These geometry tests model only the layout and query methods they read.
    return Object.assign(Object.create(null), shape);
}

function createContainerStub(options?: {
    clientWidth?: number;
    scrollLeft?: number;
}) {
    let scrollTop = 0;
    let scrollLeft = options?.scrollLeft ?? 0;

    const container = createElementShim({
        clientWidth: options?.clientWidth ?? 200,
        clientHeight: 200,
        scrollHeight: 2000,
        scrollTop: 0,
        scrollLeft,
        querySelector: () => null,
        querySelectorAll: () => [],
    });

    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });
    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = value;
        },
    });

    return {
        container,
        getScrollLeft: () => scrollLeft,
        getScrollTop: () => scrollTop,
    };
}

function createPageElementStub(
    pageNumber: number,
    top: number,
    height: number,
    buffered = false,
    options?: {
        left?: number;
        width?: number;
    },
) {
    const width = options?.width ?? 200;
    return createElementShim({
        dataset: { page: String(pageNumber) },
        offsetLeft: options?.left ?? 0,
        offsetTop: top,
        offsetWidth: width,
        offsetHeight: height,
        clientWidth: width,
        clientHeight: height,
        classList: { contains: (className: string) => buffered && className === 'page_container--buffered' },
    });
}

function createMountedPageScrollHarness(options: {
    clientWidth: number;
    clientHeight: number;
    pageNumber: number;
    pageLeft: number;
    pageTop: number;
    pageWidth: number;
    pageHeight: number;
}) {
    let scrollLeft = 0;
    let scrollTop = 0;
    const selector = `.page_container[data-page="${options.pageNumber}"]`;
    const page = createElementShim({
        dataset: { page: String(options.pageNumber) },
        offsetLeft: options.pageLeft,
        offsetTop: options.pageTop,
        offsetWidth: options.pageWidth,
        offsetHeight: options.pageHeight,
        clientWidth: options.pageWidth,
        clientHeight: options.pageHeight,
        classList: { contains: () => false },
    });
    const container = createElementShim({
        clientWidth: options.clientWidth,
        clientHeight: options.clientHeight,
        scrollWidth: Math.max(options.clientWidth, options.pageLeft + options.pageWidth),
        scrollHeight: options.pageTop + options.pageHeight,
        querySelector: (requestedSelector: string) => requestedSelector === selector ? page : null,
        querySelectorAll: () => [page],
    });

    Object.defineProperty(container, 'scrollLeft', {
        get: () => scrollLeft,
        set: (value: number) => {
            scrollLeft = value;
        },
    });
    Object.defineProperty(container, 'scrollTop', {
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });

    return {
        container,
        getScrollLeft: () => scrollLeft,
        getScrollTop: () => scrollTop,
    };
}

describe('usePdfScroll page layout fallback', () => {
    it('reports unmeasured visibility when neither DOM nor layout describes a page', () => {
        const { container } = createContainerStub();
        const scroll = usePdfScroll();

        expect(scroll.getVisiblePageRange(container, 10)).toBeNull();
        expect(scroll.getVisiblePageRange(null, 10)).toBeNull();
        expect(scroll.getVisiblePageRange(container, 0)).toBeNull();

        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 10}, () => ({
                width: 200,
                height: 100,
            })),
            totalPages: 10,
            viewMode: 'single',
            scale: 1,
            gap: 0,
            paddingTop: 0,
            paddingBottom: 0,
        }));
        container.scrollTop = 400;
        expect(scroll.getVisiblePageRange(container, 10)).toEqual({
            start: 5,
            end: 6,
        });

        scroll.setPageLayoutMetrics(null);
        expect(scroll.getVisiblePageRange(container, 10)).toBeNull();
    });

    it('prefers a pinned current page while viewport metrics are stabilizing', () => {
        const { container } = createContainerStub();
        const getPinnedMostVisiblePage = vi.fn(() => 3);
        const scroll = usePdfScroll({ getPinnedMostVisiblePage });

        expect(scroll.getMostVisiblePage(container, 5)).toBe(3);
        expect(scroll.updateCurrentPage(container, 5)).toBe(3);
        expect(scroll.currentPage.value).toBe(1);
        const authorityPage = ref(3);
        scroll.bindCurrentPageProjection(authorityPage);
        expect(scroll.currentPage.value).toBe(3);
    });

    it('scrolls to hidden pages using per-page layout metrics', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub();
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 200,
                    height: 100,
                },
                {
                    width: 200,
                    height: 250,
                },
                {
                    width: 200,
                    height: 150,
                },
            ],
            totalPages: 3,
            viewMode: 'single',
            scale: 2,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        }));

        scroll.scrollToPage(container, requirePageNumber(3), 3, 20);

        expect(getScrollTop()).toBe(740);
    });

    it('does not install a DOM reapply authority after a layout navigation', () => {
        const originalMutationObserver = globalThis.MutationObserver;
        const mutationCallbackRef: { current: MutationCallback | null } = { current: null };
        let mountedPage: HTMLElement | null = null;
        let scrollTop = 0;
        const mountedTarget = createPageElementStub(2, 1_000, 800);
        const markerRect = {
            left: 0.1,
            top: 0.45,
            width: 0.1,
            height: 0.1,
        };
        const container = createElementShim({
            clientHeight: 200,
            clientWidth: 200,
            scrollHeight: 2_000,
            scrollWidth: 200,
            scrollLeft: 0,
            querySelector: (selector: string) => (
                selector === '.page_container[data-page="2"]'
                    ? mountedPage
                    : null
            ),
            querySelectorAll: () => mountedPage ? [mountedPage] : [],
        });
        Object.defineProperty(container, 'scrollTop', {
            get: () => scrollTop,
            set: (value: number) => {
                scrollTop = value;
            },
        });

        class FakeMutationObserver {
            constructor(callback: MutationCallback) {
                mutationCallbackRef.current = callback;
            }

            observe = vi.fn();
            disconnect = vi.fn();
        }

        Object.defineProperty(globalThis, 'MutationObserver', {
            configurable: true,
            value: FakeMutationObserver,
        });

        try {
            const scroll = usePdfScroll();
            scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
                pageMetrics: [
                    {
                        width: 200,
                        height: 100,
                    },
                    {
                        width: 200,
                        height: 500,
                    },
                    {
                        width: 200,
                        height: 100,
                    },
                ],
                totalPages: 3,
                viewMode: 'single',
                scale: 1,
                gap: 20,
                paddingTop: 20,
                paddingBottom: 20,
            }));

            scroll.scrollToPage(container, requirePageNumber(2), 3, 20, { markerRect });

            expect(scrollTop).not.toBe(1_300);

            mountedPage = mountedTarget;
            expect(mutationCallbackRef.current).toBeNull();
            expect(scrollTop).not.toBe(1_300);
        } finally {
            if (originalMutationObserver) {
                Object.defineProperty(globalThis, 'MutationObserver', {
                    configurable: true,
                    value: originalMutationObserver,
                });
            } else {
                delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
            }
        }
    });

    it('prefers mounted DOM visibility when layout metrics disagree during virtualization', () => {
        const mountedPage = createPageElementStub(5, 500, 200);
        const container = createElementShim({
            clientHeight: 100,
            clientWidth: 200,
            scrollHeight: 2000,
            scrollWidth: 200,
            scrollLeft: 0,
            scrollTop: 550,
            querySelector: () => null,
            querySelectorAll: () => [mountedPage],
        });
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: Array.from({ length: 10 }, () => ({
                width: 200,
                height: 100,
            })),
            totalPages: 10,
            viewMode: 'single',
            scale: 1,
            gap: 0,
            paddingTop: 0,
            paddingBottom: 0,
        }));

        expect(scroll.getVisiblePageRange(container, 10)).toEqual({
            start: 5,
            end: 5,
        });
        expect(scroll.getMostVisiblePage(container, 10)).toBe(5);
    });

    it('ignores offscreen buffered pages when resolving visible page state', () => {
        const bufferedPage = createPageElementStub(2, 0, 300, true);
        const activePage = createPageElementStub(4, 20, 180);
        const container = createElementShim({
            clientHeight: 200,
            clientWidth: 200,
            scrollHeight: 240,
            scrollWidth: 200,
            scrollLeft: 0,
            scrollTop: 0,
            querySelector: () => null,
            querySelectorAll: () => [
                bufferedPage,
                activePage,
            ],
        });
        const scroll = usePdfScroll();

        expect(scroll.getVisiblePageRange(container, 10)).toEqual({
            start: 4,
            end: 4,
        });
        expect(scroll.getMostVisiblePage(container, 10)).toBe(4);
    });

    it('uses horizontal DOM overlap when spread pages share the same row', () => {
        const leftPage = createPageElementStub(1, 0, 200, false, {
            left: 0,
            width: 200,
        });
        const rightPage = createPageElementStub(2, 0, 200, false, {
            left: 200,
            width: 200,
        });
        const container = createElementShim({
            clientHeight: 200,
            clientWidth: 200,
            scrollHeight: 200,
            scrollWidth: 400,
            scrollLeft: 200,
            scrollTop: 0,
            querySelector: () => null,
            querySelectorAll: () => [
                leftPage,
                rightPage,
            ],
        });
        const scroll = usePdfScroll();

        expect(scroll.getVisiblePageRange(container, 2)).toEqual({
            start: 2,
            end: 2,
        });
        expect(scroll.getMostVisiblePage(container, 2)).toBe(2);
    });

    it('uses horizontal layout overlap when fallback spread pages share the same row', () => {
        const { container } = createContainerStub({
            clientWidth: 200,
            scrollLeft: 200,
        });
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 200,
                    height: 200,
                },
                {
                    width: 200,
                    height: 200,
                },
            ],
            totalPages: 2,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 0,
            paddingBottom: 0,
        }));

        expect(scroll.getVisiblePageRange(container, 2)).toEqual({
            start: 2,
            end: 2,
        });
        expect(scroll.getMostVisiblePage(container, 2)).toBe(2);
    });

    it('keeps visible tall spread siblings in the layout fallback range', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub({ clientWidth: 600 });
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 200,
                    height: 500,
                },
                {
                    width: 200,
                    height: 100,
                },
                {
                    width: 200,
                    height: 100,
                },
            ],
            totalPages: 3,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 0,
            paddingBottom: 0,
        }));

        container.scrollTop = 250;

        expect(getScrollTop()).toBe(250);
        expect(scroll.getVisiblePageRange(container, 3)).toEqual({
            start: 1,
            end: 1,
        });
        expect(scroll.getMostVisiblePage(container, 3)).toBe(1);
    });

    it('scrolls to spread rows using row-aware layout metrics', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub();
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
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
        }));

        scroll.scrollToPage(container, requirePageNumber(3), 5, 20);

        expect(getScrollTop()).toBe(160);
    });

    it('keeps marker navigation horizontally stable when the mounted page fits the viewport', () => {
        const {
            container,
            getScrollLeft,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 960,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();
        const rightSideMarkerRect = {
            left: 0.7,
            top: 0.25,
            width: 0.2,
            height: 0.1,
        };

        scroll.scrollToPage(container, requirePageNumber(2), 3, 20, { markerRect: rightSideMarkerRect });

        expect(getScrollLeft()).toBe(0);
    });

    it('bounds near-bottom marker navigation vertically to the mounted page', () => {
        const {
            container,
            getScrollTop,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 960,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();
        const nearBottomMarkerRect = {
            left: 0.1,
            top: 0.96,
            width: 0.05,
            height: 0.02,
        };

        scroll.scrollToPage(container, requirePageNumber(2), 3, 20, { markerRect: nearBottomMarkerRect });

        expect(getScrollTop()).toBe(1020);
    });

    it('aligns PDF destination y coordinates to the viewport top', () => {
        const {
            container,
            getScrollTop,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 960,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();

        scroll.scrollToPage(container, requirePageNumber(2), 3, 20, { pageYRatio: 0.25 });

        expect(getScrollTop()).toBe(580);
    });

    it('bounds marker navigation horizontally to the mounted page when the page is wider than the viewport', () => {
        const {
            container,
            getScrollLeft,
        } = createMountedPageScrollHarness({
            clientWidth: 1000,
            clientHeight: 200,
            pageNumber: 2,
            pageLeft: 20,
            pageTop: 400,
            pageWidth: 1400,
            pageHeight: 800,
        });
        const scroll = usePdfScroll();
        const farRightMarkerRect = {
            left: 0.8,
            top: 0.25,
            width: 0.2,
            height: 0.1,
        };

        scroll.scrollToPage(container, requirePageNumber(2), 3, 20, { markerRect: farRightMarkerRect });

        expect(getScrollLeft()).toBe(440);
    });

    it('applies marker horizontal positioning from layout metrics before the page mounts', () => {
        const {
            container,
            getScrollLeft,
        } = createContainerStub({ clientWidth: 200 });
        const scroll = usePdfScroll();
        scroll.setPageLayoutMetrics(buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 200,
                    height: 200,
                },
                {
                    width: 200,
                    height: 200,
                },
            ],
            totalPages: 2,
            viewMode: 'facing',
            scale: 1,
            gap: 20,
            paddingTop: 0,
            paddingBottom: 0,
        }));

        scroll.scrollToPage(container, requirePageNumber(2), 2, 20, {markerRect: {
            left: 0.8,
            top: 0.25,
            width: 0.2,
            height: 0.1,
        }});

        expect(getScrollLeft()).toBe(220);
    });

    it('translates a far layout target into its bounded physical scroll segment', () => {
        const {
            container,
            getScrollTop,
        } = createContainerStub();
        const scroll = usePdfScroll();
        const layout = buildPageLayoutMetrics({
            pageMetrics: [{
                width: 64,
                height: 64,
            }],
            totalPages: 138_000,
            viewMode: 'single',
            scale: 10,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
        });
        const targetPage = 69_001;
        const targetTop = getPageTop(layout!, requirePageNumber(targetPage))!;
        const segmentOrigin = Math.floor(targetTop / PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT)
            * PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT;
        scroll.setPageLayoutMetrics(layout);

        scroll.scrollToPage(container, requirePageNumber(targetPage), 138_000, 20);

        expect(getScrollTop()).toBe(targetTop - segmentOrigin - 20);
        expect(getScrollTop()).toBeLessThan(PDF_VIEWER_SCROLL_SEGMENT_MAX_HEIGHT);
    });
});
