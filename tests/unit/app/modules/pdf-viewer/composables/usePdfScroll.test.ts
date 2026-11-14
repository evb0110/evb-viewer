import {
    describe,
    expect,
    it,
} from 'vitest';
import { usePdfScroll as usePdfScrollProduction } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScroll';
import { buildPageLayoutMetrics } from '@app/modules/document-viewer/public';

const usePdfScroll = (
    options: Partial<Parameters<typeof usePdfScrollProduction>[0]> = {},
) => usePdfScrollProduction({
    getPhysicalScrollOrigin: () => 0,
    ...options,
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

describe('usePdfScroll page layout fallback', () => {
    it('reports unmeasured visibility when neither DOM nor layout describes a page', () => {
        const { container } = createContainerStub();
        const scroll = usePdfScroll();

        expect(scroll.getViewportVisibility(container, 10).range).toBeNull();
        expect(scroll.getViewportVisibility(null, 10).range).toBeNull();
        expect(scroll.getViewportVisibility(container, 0).range).toBeNull();

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
        expect(scroll.getViewportVisibility(container, 10).range).toEqual({
            start: 5,
            end: 6,
        });

        scroll.setPageLayoutMetrics(null);
        expect(scroll.getViewportVisibility(container, 10).range).toBeNull();
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

        expect(scroll.getViewportVisibility(container, 10).range).toEqual({
            start: 5,
            end: 5,
        });
        expect(scroll.getViewportVisibility(container, 10).mostVisiblePage).toBe(5);
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

        expect(scroll.getViewportVisibility(container, 10).range).toEqual({
            start: 4,
            end: 4,
        });
        expect(scroll.getViewportVisibility(container, 10).mostVisiblePage).toBe(4);
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

        expect(scroll.getViewportVisibility(container, 2).range).toEqual({
            start: 2,
            end: 2,
        });
        expect(scroll.getViewportVisibility(container, 2).mostVisiblePage).toBe(2);
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

        expect(scroll.getViewportVisibility(container, 2).range).toEqual({
            start: 2,
            end: 2,
        });
        expect(scroll.getViewportVisibility(container, 2).mostVisiblePage).toBe(2);
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
        expect(scroll.getViewportVisibility(container, 3).range).toEqual({
            start: 1,
            end: 1,
        });
        expect(scroll.getViewportVisibility(container, 3).mostVisiblePage).toBe(1);
    });
});
