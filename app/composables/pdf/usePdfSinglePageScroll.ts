import {
    ref,
    type Ref,
    type ShallowRef,
} from 'vue';
import { useDebounceFn } from '@vueuse/core';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { TPdfViewMode } from '@app/types/shared';
import { runGuardedTask } from '@app/utils/async-guard';
import { stepBySpread } from '@app/utils/pdf-view-mode';

const WHEEL_LINE_DELTA_PX = 16;
const PAGE_FLIP_STEP_DELTA_PX = 120;
const MIN_COARSE_PAGE_FLIP_STEP_DELTA_PX = 40;
const WHEEL_IDLE_RESET_MS = 140;
const MAX_PAGE_FLIPS_PER_EVENT = 3;
const HORIZONTAL_INTENT_REJECT_RATIO = 2.5;
const PAGE_SCROLL_EDGE_EPSILON = 1;
const WHEEL_DELTA_EPSILON = 0.01;

export type TPageSnapAnchor = 'center' | 'top' | 'bottom';
export type TWheelDirection = -1 | 1;

interface IWheelPageAccumulatorState {
    delta: number;
    direction: TWheelDirection | 0;
    lastEventTimeMs: number;
}

interface IWheelPageAccumulatorResult {
    stepsToFlip: number;
    state: IWheelPageAccumulatorState;
}

interface IAccumulateWheelForPageFlipsInput {
    state: IWheelPageAccumulatorState;
    delta: number;
    direction: TWheelDirection;
    eventTimeMs: number;
    stepDelta: number;
}

export function resolveSnapAnchorForWheelDirection(
    direction: TWheelDirection,
): TPageSnapAnchor {
    return direction > 0 ? 'top' : 'bottom';
}

export function accumulateWheelForPageFlips(
    input: IAccumulateWheelForPageFlipsInput,
): IWheelPageAccumulatorResult {
    const {
        delta,
        direction,
        eventTimeMs,
        stepDelta,
    } = input;

    let accumulatedDelta = input.state.delta;
    const isDirectionChanged =
        input.state.direction !== 0 && input.state.direction !== direction;
    const isStale =
        input.state.lastEventTimeMs > 0 &&
        eventTimeMs - input.state.lastEventTimeMs > WHEEL_IDLE_RESET_MS;

    if (isDirectionChanged || isStale) {
        accumulatedDelta = 0;
    }

    accumulatedDelta += delta;

    const safeStepDelta = Math.max(stepDelta, WHEEL_DELTA_EPSILON);
    const rawSteps = Math.floor(Math.abs(accumulatedDelta) / safeStepDelta);
    const stepsToFlip = Math.min(rawSteps, MAX_PAGE_FLIPS_PER_EVENT);
    const consumedDelta = direction * stepsToFlip * safeStepDelta;

    return {
        stepsToFlip,
        state: {
            delta: accumulatedDelta - consumedDelta,
            direction,
            lastEventTimeMs: eventTimeMs,
        },
    };
}

export function resolveWheelPageFlipStepDelta(
    event: Pick<WheelEvent, 'deltaMode'>,
    normalizedDelta: number,
) {
    const magnitude = Math.abs(normalizedDelta);
    if (magnitude < WHEEL_DELTA_EPSILON) {
        return PAGE_FLIP_STEP_DELTA_PX;
    }

    if (event.deltaMode === 1 || event.deltaMode === 2) {
        // Line/page deltas are already wheel-step-oriented; treat each event
        // as one meaningful edge-flip step.
        return magnitude;
    }

    return Math.max(
        MIN_COARSE_PAGE_FLIP_STEP_DELTA_PX,
        Math.min(PAGE_FLIP_STEP_DELTA_PX, magnitude),
    );
}

interface IUsePdfSinglePageScrollOptions {
    viewerContainer: Ref<HTMLElement | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    scaledMargin: Ref<number>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    isLoading: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    getMostVisiblePage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    scrollToPageInternal: (
        container: HTMLElement,
        page: number,
        total: number,
        margin: number,
    ) => void;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    updateCurrentPage: (
        container: HTMLElement | null,
        numPages: number,
    ) => number;
    renderVisiblePages: (range: {
        start: number;
        end: number 
    }) => Promise<void>;
    visibleRange: Ref<{
        start: number;
        end: number;
    }>;
    emitCurrentPage: (page: number) => void;
}

export function usePdfSinglePageScroll(
    options: IUsePdfSinglePageScrollOptions,
) {
    const {
        viewerContainer,
        numPages,
        currentPage,
        scaledMargin,
        viewMode,
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
    const wheelAccumulator = ref<IWheelPageAccumulatorState>({
        delta: 0,
        direction: 0,
        lastEventTimeMs: 0,
    });

    const debouncedRenderOnScroll = useDebounceFn(() => {
        if (isLoading.value || !pdfDocument.value) {
            return;
        }
        runGuardedTask(() => renderVisiblePages(visibleRange.value), {
            scope: 'pdf-single-page-scroll',
            message: 'Failed to render visible pages on scroll',
        });
    }, 100);

    function normalizeWheelDelta(
        delta: number,
        mode: number,
        container: HTMLElement,
    ) {
        if (mode === 1) {
            return delta * WHEEL_LINE_DELTA_PX;
        }
        if (mode === 2) {
            return delta * container.clientHeight;
        }
        return delta;
    }

    function clearWheelAccumulator() {
        wheelAccumulator.value = {
            delta: 0,
            direction: 0,
            lastEventTimeMs: 0,
        };
    }

    function getPageScrollBounds(pageNumber: number) {
        const container = viewerContainer.value;
        if (!container || numPages.value === 0) {
            return null;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        const pageElement = container.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPage}"]`,
        );
        if (!pageElement) {
            return null;
        }

        const maxScrollTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
        );
        const unclampedMin = Math.max(0, pageElement.offsetTop - scaledMargin.value);
        const unclampedMax =
            unclampedMin + Math.max(0, pageElement.offsetHeight - container.clientHeight);
        const min = Math.min(maxScrollTop, unclampedMin);
        const max = Math.min(maxScrollTop, Math.max(min, unclampedMax));

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
        return (
            top > bounds.min + PAGE_SCROLL_EDGE_EPSILON &&
      top < bounds.max - PAGE_SCROLL_EDGE_EPSILON
        );
    }

    function isTallPage(pageNumber: number) {
        const bounds = getPageScrollBounds(pageNumber);
        if (!bounds) {
            return false;
        }
        return bounds.max - bounds.min > PAGE_SCROLL_EDGE_EPSILON;
    }

    function snapToPage(pageNumber: number, anchor: TPageSnapAnchor = 'center') {
        if (!viewerContainer.value || numPages.value === 0) {
            return;
        }

        const targetPage = Math.max(1, Math.min(pageNumber, numPages.value));
        const targetEl = viewerContainer.value.querySelector<HTMLElement>(
            `.page_container[data-page="${targetPage}"]`,
        );
        if (!targetEl) {
            return;
        }

        const container = viewerContainer.value;
        const containerHeight = container.clientHeight;
        const targetHeight = targetEl.offsetHeight;
        const baseTop = targetEl.offsetTop - scaledMargin.value;
        const maxTop = Math.max(0, container.scrollHeight - containerHeight);
        const topTarget = Math.min(maxTop, Math.max(0, baseTop));
        const centerOffset = Math.max(0, (containerHeight - targetHeight) / 2);
        const centerTarget = Math.min(maxTop, Math.max(0, baseTop - centerOffset));
        const bottomTarget = Math.min(
            maxTop,
            Math.max(0, baseTop + targetHeight - containerHeight),
        );
        const targetTop = anchor === 'top'
            ? topTarget
            : anchor === 'bottom'
                ? bottomTarget
                : centerTarget;
        isSnapping.value = true;
        container.scrollTop = targetTop;
        currentPage.value = targetPage;
        emitCurrentPage(targetPage);

        requestAnimationFrame(() => {
            isSnapping.value = false;
        });
    }

    const debouncedSnapToPage = useDebounceFn(() => {
        if (
            isLoading.value ||
      !pdfDocument.value ||
      continuousScroll.value ||
      isSnapping.value
        ) {
            return;
        }
        const page = getMostVisiblePage(viewerContainer.value, numPages.value);
        if (isWithinTallPageInterior(page)) {
            return;
        }
        if (page === currentPage.value && isTallPage(page)) {
            return;
        }
        snapToPage(page, 'center');
    }, 120);

    function handleWheel(event: WheelEvent) {
        if (
            continuousScroll.value ||
      isLoading.value ||
      !pdfDocument.value ||
      !viewerContainer.value ||
      numPages.value === 0 ||
      event.ctrlKey ||
      event.metaKey
        ) {
            return;
        }

        if (event.deltaY === 0) {
            return;
        }

        if (
            Math.abs(event.deltaX) >
            Math.abs(event.deltaY) * HORIZONTAL_INTENT_REJECT_RATIO
        ) {
            return;
        }

        const container = viewerContainer.value;
        const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, container);
        if (Math.abs(delta) < WHEEL_DELTA_EPSILON) {
            return;
        }

        event.preventDefault();
        const direction: TWheelDirection = delta > 0 ? 1 : -1;
        const activePage = getMostVisiblePage(container, numPages.value);
        const bounds = getPageScrollBounds(activePage);

        if (bounds) {
            const canScrollWithinPage =
                direction > 0
                    ? container.scrollTop < bounds.max - PAGE_SCROLL_EDGE_EPSILON
                    : container.scrollTop > bounds.min + PAGE_SCROLL_EDGE_EPSILON;

            if (canScrollWithinPage) {
                clearWheelAccumulator();
                const nextTop =
                    direction > 0
                        ? Math.min(bounds.max, container.scrollTop + delta)
                        : Math.max(bounds.min, container.scrollTop + delta);
                container.scrollTop = nextTop;
                return;
            }
        }

        const accumulationResult = accumulateWheelForPageFlips({
            state: wheelAccumulator.value,
            delta,
            direction,
            eventTimeMs: event.timeStamp,
            stepDelta: resolveWheelPageFlipStepDelta(event, delta),
        });
        wheelAccumulator.value = accumulationResult.state;
        if (accumulationResult.stepsToFlip === 0) {
            return;
        }

        // Keep paged scrolling predictable: one spread turn per wheel threshold.
        const targetPage = stepBySpread(
            activePage,
            viewMode.value,
            numPages.value,
            direction,
            1,
        );
        if (targetPage === activePage) {
            clearWheelAccumulator();
            return;
        }

        snapToPage(targetPage, resolveSnapAnchorForWheelDirection(direction));
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
            snapToPage(pageNumber, 'center');
        }

        queueMicrotask(() => {
            if (isLoading.value || !pdfDocument.value) {
                return;
            }
            updateVisibleRange(viewerContainer.value, numPages.value);
            runGuardedTask(() => renderVisiblePages(visibleRange.value), {
                scope: 'pdf-single-page-scroll',
                message: 'Failed to render visible pages after scrollToPage',
            });
        });
    }

    function resetContinuousScrollState() {
        clearWheelAccumulator();
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
