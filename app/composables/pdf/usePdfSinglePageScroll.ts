import {
    ref,
    type Ref,
    type ShallowRef,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { WHEEL_PAGE_LOCK_MS } from '@app/constants/timeouts';

const WHEEL_LINE_DELTA_PX = 16;
const WHEEL_PAGE_TRIGGER_DELTA = 70;
const PAGE_SCROLL_EDGE_EPSILON = 1;

interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    scaledMargin: Ref<number>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getMostVisiblePage: (container: HTMLElement | null, numPages: number) => number;
    scrollToPageInternal: (container: HTMLElement, page: number, total: number, margin: number) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (container: HTMLElement | null, numPages: number) => number;
    renderVisiblePages: (range: {
        start: number;
        end: number 
    }) => Promise<void>;
    visibleRange: Ref<{
        start: number;
        end: number 
    }>;
    emitCurrentPage: (page: number) => void;
}

export function usePdfSinglePageScroll(options: IUsePdfSinglePageScrollOptions) {
    const {
        viewerContainer,
        numPages,
        currentPage,
        scaledMargin,
        continuousScroll,
        isLoading,
        pdfDocument,
        getMostVisiblePage,
        scrollToPageInternal,
        updateVisibleRange,
        updateCurrentPage,
        renderVisiblePages,
        visibleRange,
        emitCurrentPage,
    } = options;

    const isSnapping = ref(false);
    const wheelScrollDelta = ref(0);
    const isWheelPageSnapLocked = ref(false);

    const debouncedRenderOnScroll = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        console.log('[ROT-DIAG] debouncedRenderOnScroll → renderVisiblePages');
        void renderVisiblePages(visibleRange.value);
    }, 100);

    function normalizeWheelDelta(delta: number, mode: number, container: HTMLElement) {
        if (mode === 1) {
            return delta * WHEEL_LINE_DELTA_PX;
        }
        if (mode === 2) {
            return delta * container.clientHeight;
        }
        return delta;
    }

    function getPageScrollBounds(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container || numPages.value === 0) {
            return null;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        const pageContainers = container.querySelectorAll('.page_container');
        const pageElement = pageContainers[targetPage - 1] as HTMLElement | undefined;
        if (!pageElement) {
            return null;
        }

        const min = Math.max(0, pageElement.offsetTop - scaledMargin.value);
        const max = min + Math.max(0, pageElement.offsetHeight - container.clientHeight);

        return {
            min,
            max,
        };
    }

    function isWithinTallPageInterior(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }

        const bounds = getPageScrollBounds(pageNumber);
        if (!bounds || bounds.max - bounds.min <= PAGE_SCROLL_EDGE_EPSILON) {
            return false;
        }

        const top = container.scrollTop;
        return top > bounds.min + PAGE_SCROLL_EDGE_EPSILON
            && top < bounds.max - PAGE_SCROLL_EDGE_EPSILON;
    }

    function isTallPage(pageNumber: number) {
        const bounds = getPageScrollBounds(pageNumber);
        if (!bounds) {
            return false;
        }
        return bounds.max - bounds.min > PAGE_SCROLL_EDGE_EPSILON;
    }

    function snapToPage(pageNumber: number) {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        const pageContainers = viewerContainer.value.querySelectorAll('.page_container');
        const targetEl = pageContainers[targetPage - 1] as HTMLElement | undefined;
        if (!targetEl) {
            return;
        }

        const container = viewerContainer.value;
        const containerHeight = container.clientHeight;
        const targetHeight = targetEl.offsetHeight;
        const baseTop = targetEl.offsetTop - scaledMargin.value;
        const centerOffset = Math.max(0, (containerHeight - targetHeight) / 2);
        const maxTop = Math.max(0, container.scrollHeight - containerHeight);
        const targetTop = Math.min(maxTop, Math.max(0, baseTop - centerOffset));
        isSnapping.value = true;
        container.scrollTop = targetTop;
        currentPage.value = targetPage;
        emitCurrentPage(targetPage);

        requestAnimationFrame(() => {
            isSnapping.value = false;
        });
    }

    const debouncedSnapToPage = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value || continuousScroll.value || isSnapping.value) {
            return;
        }
        const page = getMostVisiblePage(viewerContainer.value, numPages.value);
        if (isWithinTallPageInterior(page)) {
            return;
        }
        if (page === currentPage.value && isTallPage(page)) {
            return;
        }
        snapToPage(page);
    }, 120);

    function handleWheel(event: WheelEvent) {
        if (
            continuousScroll.value
            || isLoading.value
            || !pdfDocument.value
            || !viewerContainer.value
            || numPages.value === 0
            || event.ctrlKey
            || event.metaKey
        ) {
            return;
        }

        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) {
            return;
        }

        const container = viewerContainer.value;
        const delta = normalizeWheelDelta(
            event.deltaY,
            event.deltaMode,
            container,
        );
        if (Math.abs(delta) < 0.01) {
            return;
        }

        event.preventDefault();
        const direction = delta > 0 ? 1 : -1;
        const activePage = getMostVisiblePage(container, numPages.value);
        const bounds = getPageScrollBounds(activePage);

        if (bounds) {
            const canScrollWithinPage = direction > 0
                ? container.scrollTop < bounds.max - PAGE_SCROLL_EDGE_EPSILON
                : container.scrollTop > bounds.min + PAGE_SCROLL_EDGE_EPSILON;

            if (canScrollWithinPage) {
                wheelScrollDelta.value = 0;
                isWheelPageSnapLocked.value = false;
                const nextTop = direction > 0
                    ? Math.min(bounds.max, container.scrollTop + delta)
                    : Math.max(bounds.min, container.scrollTop + delta);
                container.scrollTop = nextTop;
                return;
            }
        }

        if (isWheelPageSnapLocked.value) {
            return;
        }

        wheelScrollDelta.value += delta;

        if (Math.abs(wheelScrollDelta.value) < WHEEL_PAGE_TRIGGER_DELTA) {
            return;
        }

        wheelScrollDelta.value = 0;

        const targetPage = Math.max(1, Math.min(numPages.value, activePage + direction));
        if (targetPage === activePage) {
            return;
        }

        isWheelPageSnapLocked.value = true;
        snapToPage(targetPage);

        window.setTimeout(() => {
            isWheelPageSnapLocked.value = false;
        }, WHEEL_PAGE_LOCK_MS);
    }

    function handleScroll() {
        if (isLoading.value) {
            return;
        }

        updateVisibleRange(viewerContainer.value, numPages.value);
        debouncedRenderOnScroll();

        const previous = currentPage.value;
        const page = updateCurrentPage(viewerContainer.value, numPages.value);
        if (page !== previous) {
            emitCurrentPage(page);
        }

        if (!continuousScroll.value && !isSnapping.value) {
            debouncedSnapToPage();
        }
    }

    function scrollToPage(pageNumber: number) {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        if (continuousScroll.value) {
            scrollToPageInternal(
                viewerContainer.value,
                pageNumber,
                numPages.value,
                scaledMargin.value,
            );
            emitCurrentPage(currentPage.value);
        } else {
            snapToPage(pageNumber);
        }

        queueMicrotask(() => {
            if (isLoading.value || !pdfDocument.value) {
                return;
            }
            console.log('[ROT-DIAG] scrollToPage microtask → renderVisiblePages');
            updateVisibleRange(viewerContainer.value, numPages.value);
            void renderVisiblePages(visibleRange.value);
        });
    }

    function resetContinuousScrollState() {
        wheelScrollDelta.value = 0;
        isWheelPageSnapLocked.value = false;
    }

    return {
        isSnapping,
        handleWheel,
        handleScroll,
        scrollToPage,
        snapToPage,
        resetContinuousScrollState,
    };
}
