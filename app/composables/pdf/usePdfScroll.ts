import { ref } from 'vue';
import type { IScrollSnapshot } from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';

interface IUniformPageLayoutMetrics {
    pageHeight: number;
    gap: number;
    paddingTop: number;
    totalPages: number;
}

export const usePdfScroll = () => {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1, 
    });
    const uniformLayoutMetrics = ref<IUniformPageLayoutMetrics | null>(null);

    function setUniformLayoutMetrics(metrics: IUniformPageLayoutMetrics | null) {
        uniformLayoutMetrics.value = metrics;
    }

    function getVisiblePageRangeFromUniformLayout(
        container: HTMLElement,
        totalPages: number,
    ) {
        const metrics = uniformLayoutMetrics.value;
        if (!metrics || metrics.totalPages !== totalPages) {
            return null;
        }

        const stride = metrics.pageHeight + metrics.gap;
        if (stride <= 0) {
            return null;
        }

        const viewportTop = Math.max(0, container.scrollTop - metrics.paddingTop);
        const viewportBottom = viewportTop + container.clientHeight;
        const start = clamp(Math.floor(viewportTop / stride) + 1, 1, totalPages);
        const end = clamp(Math.max(start, Math.ceil(viewportBottom / stride)), 1, totalPages);

        return {
            start,
            end,
        };
    }

    function getMostVisiblePageFromUniformLayout(
        container: HTMLElement,
        totalPages: number,
    ) {
        const metrics = uniformLayoutMetrics.value;
        if (!metrics || metrics.totalPages !== totalPages) {
            return null;
        }

        const stride = metrics.pageHeight + metrics.gap;
        if (stride <= 0) {
            return null;
        }

        const viewportCenter = Math.max(
            0,
            container.scrollTop - metrics.paddingTop + container.clientHeight / 2,
        );
        return clamp(Math.floor(viewportCenter / stride) + 1, 1, totalPages);
    }

    function getVisiblePageRange(
        container: HTMLElement | null,
        totalPages: number,
    ): {
        start: number;
        end: number 
    } {
        if (!container || totalPages === 0) {
            return {
                start: 1,
                end: 1, 
            };
        }

        const uniformRange = getVisiblePageRangeFromUniformLayout(container, totalPages);
        if (uniformRange) {
            return uniformRange;
        }

        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const viewportTop = scrollTop;
        const viewportBottom = scrollTop + containerRect.height;

        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');
        let firstVisible = 1;
        let lastVisible = 1;
        let foundFirst = false;

        for (const pageEl of pageContainers) {
            const pageTop = pageEl.offsetTop;
            const pageBottom = pageTop + pageEl.offsetHeight;
            const pageNumber = Number.parseInt(pageEl.dataset.page ?? '', 10);
            if (!Number.isFinite(pageNumber) || pageNumber < 1) {
                continue;
            }

            const isVisible = pageBottom > viewportTop && pageTop < viewportBottom;

            if (isVisible) {
                if (!foundFirst) {
                    firstVisible = pageNumber;
                    foundFirst = true;
                }
                lastVisible = pageNumber;
            } else if (foundFirst) {
                break;
            }
        }

        return {
            start: firstVisible,
            end: lastVisible, 
        };
    }

    function getMostVisiblePage(
        container: HTMLElement | null,
        totalPages: number,
    ): number {
        if (!container || totalPages === 0) {
            return 1;
        }

        const uniformPage = getMostVisiblePageFromUniformLayout(container, totalPages);
        if (uniformPage !== null) {
            return uniformPage;
        }

        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const viewportTop = scrollTop;
        const viewportBottom = scrollTop + containerRect.height;

        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');
        let mostVisiblePage = 1;
        let maxVisibleArea = 0;

        for (const pageEl of pageContainers) {
            const pageTop = pageEl.offsetTop;
            const pageBottom = pageTop + pageEl.offsetHeight;
            const pageNumber = Number.parseInt(pageEl.dataset.page ?? '', 10);
            if (!Number.isFinite(pageNumber) || pageNumber < 1) {
                continue;
            }

            const visibleTop = Math.max(pageTop, viewportTop);
            const visibleBottom = Math.min(pageBottom, viewportBottom);
            const visibleArea = Math.max(0, visibleBottom - visibleTop);

            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                mostVisiblePage = pageNumber;
            }

            if (pageTop > viewportBottom) {
                break;
            }
        }

        return mostVisiblePage;
    }

    function scrollToPage(
        container: HTMLElement | null,
        pageNumber: number,
        totalPages: number,
        margin: number,
    ) {
        if (!container || totalPages === 0) {
            return;
        }

        const targetPage = clamp(pageNumber, 1, totalPages);
        const metrics = uniformLayoutMetrics.value;
        if (metrics && metrics.totalPages === totalPages) {
            const stride = metrics.pageHeight + metrics.gap;
            const top = metrics.paddingTop + (targetPage - 1) * stride;
            container.scrollTop = Math.max(0, top - margin);
            currentPage.value = targetPage;
            return;
        }

        const targetEl = container.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPage}"]`,
        );

        if (targetEl) {
            container.scrollTop = targetEl.offsetTop - margin;
            currentPage.value = targetPage;
        }
    }

    function captureScrollSnapshot(container: HTMLElement | null): IScrollSnapshot | null {
        if (!container) {
            return null;
        }

        const {
            scrollWidth,
            scrollHeight,
        } = container;

        if (!scrollWidth || !scrollHeight) {
            return null;
        }

        return {
            width: scrollWidth,
            height: scrollHeight,
            centerX: container.scrollLeft + container.clientWidth / 2,
            centerY: container.scrollTop + container.clientHeight / 2,
        };
    }

    function restoreScrollFromSnapshot(
        container: HTMLElement | null,
        snapshot: IScrollSnapshot | null,
    ) {
        if (!snapshot || !container) {
            return;
        }

        const newWidth = container.scrollWidth;
        const newHeight = container.scrollHeight;

        if (!newWidth || !newHeight || !snapshot.width || !snapshot.height) {
            return;
        }

        const targetLeft = (snapshot.centerX / snapshot.width) * newWidth - container.clientWidth / 2;
        const targetTop = (snapshot.centerY / snapshot.height) * newHeight - container.clientHeight / 2;

        container.scrollLeft = Math.max(0, targetLeft);
        container.scrollTop = Math.max(0, targetTop);
    }

    function updateVisibleRange(container: HTMLElement | null, totalPages: number) {
        visibleRange.value = getVisiblePageRange(container, totalPages);
    }

    function updateCurrentPage(container: HTMLElement | null, totalPages: number) {
        const page = getMostVisiblePage(container, totalPages);
        if (page !== currentPage.value) {
            currentPage.value = page;
        }
        return page;
    }

    return {
        currentPage,
        visibleRange,
        getVisiblePageRange,
        getMostVisiblePage,
        setUniformLayoutMetrics,
        scrollToPage,
        captureScrollSnapshot,
        restoreScrollFromSnapshot,
        updateVisibleRange,
        updateCurrentPage,
    };
};
