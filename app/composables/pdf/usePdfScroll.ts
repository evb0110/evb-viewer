import { ref } from 'vue';
import type { IScrollSnapshot } from 'app/types/pdf';

export const usePdfScroll = () => {
    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1, 
    });

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

        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const viewportTop = scrollTop;
        const viewportBottom = scrollTop + containerRect.height;

        const pageContainers = container.querySelectorAll('.page_container');
        let firstVisible = 1;
        let lastVisible = 1;
        let foundFirst = false;

        for (let i = 0; i < pageContainers.length; i++) {
            const pageEl = pageContainers[i] as HTMLElement;
            const pageTop = pageEl.offsetTop;
            const pageBottom = pageTop + pageEl.offsetHeight;

            const isVisible = pageBottom > viewportTop && pageTop < viewportBottom;

            if (isVisible) {
                if (!foundFirst) {
                    firstVisible = i + 1;
                    foundFirst = true;
                }
                lastVisible = i + 1;
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

        const containerRect = container.getBoundingClientRect();
        const scrollTop = container.scrollTop;
        const viewportTop = scrollTop;
        const viewportBottom = scrollTop + containerRect.height;

        const pageContainers = container.querySelectorAll('.page_container');
        let mostVisiblePage = 1;
        let maxVisibleArea = 0;

        for (let i = 0; i < pageContainers.length; i++) {
            const pageEl = pageContainers[i] as HTMLElement;
            const pageTop = pageEl.offsetTop;
            const pageBottom = pageTop + pageEl.offsetHeight;

            const visibleTop = Math.max(pageTop, viewportTop);
            const visibleBottom = Math.min(pageBottom, viewportBottom);
            const visibleArea = Math.max(0, visibleBottom - visibleTop);

            if (visibleArea > maxVisibleArea) {
                maxVisibleArea = visibleArea;
                mostVisiblePage = i + 1;
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

        const targetPage = Math.max(1, Math.min(pageNumber, totalPages));
        const pageContainers = container.querySelectorAll('.page_container');
        const targetEl = pageContainers[targetPage - 1] as HTMLElement | undefined;

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
            scrollWidth, scrollHeight, 
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
        scrollToPage,
        captureScrollSnapshot,
        restoreScrollFromSnapshot,
        updateVisibleRange,
        updateCurrentPage,
    };
};
