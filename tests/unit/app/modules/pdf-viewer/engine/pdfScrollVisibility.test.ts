import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getViewportVisibility,
    getViewportVisibilityFromDom,
} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import {
    buildPageLayoutMetrics,
    type IPdfPageLayoutMetrics,
} from '@app/modules/document-viewer/public';

function createPageElement(options: {
    height: number;
    left: number;
    page: number;
    top: number;
    width: number;
}) {
    // This helper supplies only the layout fields read by the pure visibility
    // calculator. It is intentionally a structural HTMLElement shim.
    return Object.assign(Object.create(null), {
        classList: { contains: vi.fn(() => false) },
        dataset: { page: String(options.page) },
        offsetHeight: options.height,
        offsetLeft: options.left,
        offsetTop: options.top,
        offsetWidth: options.width,
    });
}

describe('getViewportVisibilityFromDom', () => {
    it('uses horizontal overlap when choosing the most visible page', () => {
        const pages = [
            createPageElement({
                height: 100,
                left: 0,
                page: 1,
                top: 0,
                width: 200,
            }),
            createPageElement({
                height: 100,
                left: 200,
                page: 2,
                top: 0,
                width: 200,
            }),
        ];
        const container = Object.assign(Object.create(null), {
            clientHeight: 100,
            clientWidth: 100,
            querySelectorAll: vi.fn(() => pages),
            scrollLeft: 160,
            scrollTop: 0,
        });

        expect(getViewportVisibilityFromDom(container, 2)).toEqual({
            range: {
                start: 1,
                end: 2,
            },
            mostVisiblePage: 2,
        });
    });
});

/** The visibility a viewport reports against the layout it was given last. */
function createVisibilityProbe() {
    let layout: IPdfPageLayoutMetrics | null = null;
    return {
        setPageLayoutMetrics(next: IPdfPageLayoutMetrics | null) {
            layout = next;
        },
        getViewportVisibility: (container: HTMLElement | null, totalPages: number) => getViewportVisibility(container, totalPages, layout),
    };
}

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

describe('viewport visibility page layout fallback', () => {
    it('reports unmeasured visibility when neither DOM nor layout describes a page', () => {
        const { container } = createContainerStub();
        const scroll = createVisibilityProbe();

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
        const scroll = createVisibilityProbe();
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
        const scroll = createVisibilityProbe();

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
        const scroll = createVisibilityProbe();

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
        const scroll = createVisibilityProbe();
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
        const scroll = createVisibilityProbe();
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
