import type { IViewportVisibilityResult } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/pdfScrollVisibilityTypes';
import {
    getViewportVisibilityFromDom,
    getViewportVisibilityFromLayout,
} from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';
import type { IPdfPageLayoutMetrics } from '@app/modules/document-viewer/public';

export type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';

type TPageLayoutMetrics = IPdfPageLayoutMetrics;

interface IUsePdfScrollOptions {getPhysicalScrollOrigin: () => number;}

interface IViewportVisibilityCacheEntry {
    container: HTMLElement;
    totalPages: number;
    scrollTop: number;
    scrollLeft: number;
    clientWidth: number;
    clientHeight: number;
    layoutMetrics: TPageLayoutMetrics | null;
    result: IViewportVisibilityResult;
}

/**
 * The page layout the viewport placed and what of it is visible. Placement
 * itself belongs to the viewport authority.
 */
export const usePdfScroll = (options: IUsePdfScrollOptions) => {
    const currentPageProjection = shallowRef<{projection: Readonly<Ref<number>>} | null>(null);
    const currentPage = computed(() => currentPageProjection.value?.projection.value ?? 1);
    const pageLayoutMetrics = shallowRef<TPageLayoutMetrics | null>(null);
    let viewportVisibilityCache: IViewportVisibilityCacheEntry | null = null;

    function setPageLayoutMetrics(metrics: TPageLayoutMetrics | null) {
        pageLayoutMetrics.value = metrics;
        viewportVisibilityCache = null;
    }

    function isViewportVisibilityCacheValid(
        cached: IViewportVisibilityCacheEntry | null,
        container: HTMLElement,
        totalPages: number,
        metrics: TPageLayoutMetrics | null,
    ): cached is IViewportVisibilityCacheEntry {
        return !!cached
            && cached.container === container
            && cached.totalPages === totalPages
            && cached.scrollTop === container.scrollTop
            && cached.scrollLeft === container.scrollLeft
            && cached.clientWidth === container.clientWidth
            && cached.clientHeight === container.clientHeight
            && cached.layoutMetrics === metrics;
    }

    function cacheViewportVisibility(
        container: HTMLElement,
        totalPages: number,
        metrics: TPageLayoutMetrics | null,
        result: IViewportVisibilityResult,
    ) {
        viewportVisibilityCache = {
            container,
            totalPages,
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            clientWidth: container.clientWidth,
            clientHeight: container.clientHeight,
            layoutMetrics: metrics,
            result,
        };
    }

    function resolveViewportVisibility(
        container: HTMLElement,
        totalPages: number,
    ) {
        const domVisibility = getViewportVisibilityFromDom(container, totalPages);
        return domVisibility.range || domVisibility.mostVisiblePage !== null
            ? domVisibility
            : getViewportVisibilityFromLayout(
                container,
                totalPages,
                pageLayoutMetrics.value,
                options.getPhysicalScrollOrigin(),
            ) ?? domVisibility;
    }

    function getViewportVisibility(
        container: HTMLElement | null,
        totalPages: number,
    ): IViewportVisibilityResult {
        if (!container || totalPages <= 0) {
            return {
                range: null,
                mostVisiblePage: null,
            };
        }

        const metrics = pageLayoutMetrics.value;
        if (isViewportVisibilityCacheValid(viewportVisibilityCache, container, totalPages, metrics)) {
            return viewportVisibilityCache.result;
        }

        const result = resolveViewportVisibility(container, totalPages);
        cacheViewportVisibility(container, totalPages, metrics, result);
        return result;
    }

    function bindCurrentPageProjection(projection: Readonly<Ref<number>>) {
        currentPageProjection.value = {projection};
    }

    return {
        currentPage,
        getViewportVisibility,
        setPageLayoutMetrics,
        getPageLayoutMetrics: () => pageLayoutMetrics.value,
        bindCurrentPageProjection,
    };
};
