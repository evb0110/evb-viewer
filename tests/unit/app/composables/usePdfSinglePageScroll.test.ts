import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    accumulateWheelForPageFlips,
    resolveWheelPageFlipStepDelta,
    resolveSnapAnchorForWheelDirection,
    usePdfSinglePageScroll,
} from '@app/composables/pdf/usePdfSinglePageScroll';
import type { TPdfViewMode } from '@app/types/shared';

interface ITestPageGeometry {
    offsetTop: number;
    offsetHeight: number;
}

interface IScrollHarnessOptions {
    viewMode?: TPdfViewMode;
    pageGeometries?: ITestPageGeometry[];
    getMostVisiblePage?: (viewer: HTMLElement | null) => number;
}

function createWheelEvent(
    deltaY: number,
    timeStamp: number,
    deltaX = 0,
    deltaMode = 0,
): WheelEvent {
    return {
        deltaX,
        deltaY,
        deltaMode,
        timeStamp,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
    } as WheelEvent;
}

function createSinglePageScrollHarness(options?: IScrollHarnessOptions) {
    const pageGeometries: ITestPageGeometry[] = options?.pageGeometries ?? [
        {
            offsetTop: 20,
            offsetHeight: 100,
        },
        {
            offsetTop: 140,
            offsetHeight: 180,
        },
        {
            offsetTop: 340,
            offsetHeight: 100,
        },
    ];

    const pageElements = pageGeometries.map((page) => page as HTMLElement);
    const container = {
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 440,
        querySelectorAll: vi.fn(() => pageElements),
    } as HTMLElement;

    const currentPage = ref(1);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });
    const emitCurrentPage = vi.fn((page: number) => {
        currentPage.value = page;
    });

    const defaultMostVisiblePage = (viewer: HTMLElement | null) => {
        if (!viewer) {
            return 1;
        }
        if (viewer.scrollTop >= 320) {
            return 3;
        }
        if (viewer.scrollTop >= 120) {
            return 2;
        }
        return 1;
    };
    const getMostVisiblePage = options?.getMostVisiblePage ?? defaultMostVisiblePage;

    const singlePageScroll = usePdfSinglePageScroll({
        viewerContainer: ref(container),
        numPages: ref(pageGeometries.length),
        currentPage,
        scaledMargin: ref(20),
        viewMode: ref(options?.viewMode ?? 'single'),
        continuousScroll: ref(false),
        isLoading: ref(false),
        pdfDocument: shallowRef({} as PDFDocumentProxy),
        getMostVisiblePage,
        scrollToPageInternal: vi.fn(),
        updateVisibleRange: vi.fn(),
        updateCurrentPage: vi.fn((viewer: HTMLElement | null) => getMostVisiblePage(viewer)),
        renderVisiblePages: vi.fn(async () => {}),
        visibleRange,
        emitCurrentPage,
    });

    return {
        container,
        currentPage,
        singlePageScroll,
    };
}

describe('usePdfSinglePageScroll helpers', () => {
    it('accumulates small deltas and flips only after threshold', () => {
        let state = {
            delta: 0,
            direction: 0 as const,
            lastEventTimeMs: 0,
        };

        let result = accumulateWheelForPageFlips({
            state,
            delta: 40,
            direction: 1,
            eventTimeMs: 10,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(0);
        expect(result.state.delta).toBe(40);

        state = result.state;
        result = accumulateWheelForPageFlips({
            state,
            delta: 50,
            direction: 1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(0);
        expect(result.state.delta).toBe(90);

        state = result.state;
        result = accumulateWheelForPageFlips({
            state,
            delta: 40,
            direction: 1,
            eventTimeMs: 30,
            stepDelta: 120,
        });
        expect(result.stepsToFlip).toBe(1);
        expect(result.state.delta).toBe(10);
    });

    it('applies repeated flips without time lock and caps flips per event', () => {
        const first = accumulateWheelForPageFlips({
            state: {
                delta: 0,
                direction: 0,
                lastEventTimeMs: 0,
            },
            delta: 130,
            direction: 1,
            eventTimeMs: 10,
            stepDelta: 120,
        });
        expect(first.stepsToFlip).toBe(1);

        const second = accumulateWheelForPageFlips({
            state: first.state,
            delta: 130,
            direction: 1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(second.stepsToFlip).toBe(1);

        const capped = accumulateWheelForPageFlips({
            state: {
                delta: 0,
                direction: 0,
                lastEventTimeMs: 0,
            },
            delta: 720,
            direction: 1,
            eventTimeMs: 30,
            stepDelta: 120,
        });
        expect(capped.stepsToFlip).toBe(3);
    });

    it('resets accumulated progress on direction change and idle gap', () => {
        const changedDirection = accumulateWheelForPageFlips({
            state: {
                delta: 100,
                direction: 1,
                lastEventTimeMs: 10,
            },
            delta: -30,
            direction: -1,
            eventTimeMs: 20,
            stepDelta: 120,
        });
        expect(changedDirection.stepsToFlip).toBe(0);
        expect(changedDirection.state.delta).toBe(-30);

        const stale = accumulateWheelForPageFlips({
            state: {
                delta: 100,
                direction: 1,
                lastEventTimeMs: 10,
            },
            delta: 50,
            direction: 1,
            eventTimeMs: 200,
            stepDelta: 120,
        });
        expect(stale.stepsToFlip).toBe(0);
        expect(stale.state.delta).toBe(50);
    });

    it('maps wheel direction to directional page anchors', () => {
        expect(resolveSnapAnchorForWheelDirection(1)).toBe('top');
        expect(resolveSnapAnchorForWheelDirection(-1)).toBe('bottom');
    });

    it('resolves adaptive step sizes from wheel mode and delta magnitude', () => {
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 1 }, 16)).toBe(16);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 2 }, 500)).toBe(500);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 20)).toBe(40);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 100)).toBe(100);
        expect(resolveWheelPageFlipStepDelta({ deltaMode: 0 }, 240)).toBe(120);
    });
});

describe('usePdfSinglePageScroll wheel behavior', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('scrolls inside tall page first, then flips only at page edge', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        const downToSecond = createWheelEvent(120, 10);
        singlePageScroll.handleWheel(downToSecond);
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(120);
        expect(downToSecond.preventDefault).toHaveBeenCalledOnce();

        singlePageScroll.handleWheel(createWheelEvent(60, 20));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(180);

        singlePageScroll.handleWheel(createWheelEvent(60, 30));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(200);

        singlePageScroll.handleWheel(createWheelEvent(120, 40));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);
    });

    it('clears boundary accumulation and flips promptly when wheeling up', () => {
        const {
            container,
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(120, 10));
        singlePageScroll.handleWheel(createWheelEvent(60, 20));
        singlePageScroll.handleWheel(createWheelEvent(60, 30));
        singlePageScroll.handleWheel(createWheelEvent(120, 40));

        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);

        singlePageScroll.handleWheel(createWheelEvent(400, 50));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(320);

        singlePageScroll.handleWheel(createWheelEvent(-60, 60));
        expect(currentPage.value).toBe(2);
        expect(container.scrollTop).toBe(200);
    });

    it('does not reject mixed diagonal gestures when vertical intent is clear', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(120, 10, 150));
        expect(currentPage.value).toBe(2);
    });

    it('flips on a single line-mode wheel tick at page edge', () => {
        const {
            currentPage,
            singlePageScroll,
        } = createSinglePageScrollHarness();

        singlePageScroll.handleWheel(createWheelEvent(1, 10, 0, 1));
        expect(currentPage.value).toBe(2);
    });

    it('moves one spread per wheel threshold in facing mode', () => {
        const {
            currentPage,
            container,
            singlePageScroll,
        } = createSinglePageScrollHarness({
            viewMode: 'facing',
            pageGeometries: [
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 20,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 140,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 260,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
                {
                    offsetTop: 380,
                    offsetHeight: 100,
                },
            ],
            getMostVisiblePage: (viewer) => {
                if (!viewer) {
                    return 1;
                }
                if (viewer.scrollTop >= 360) {
                    return 7;
                }
                if (viewer.scrollTop >= 240) {
                    return 5;
                }
                if (viewer.scrollTop >= 120) {
                    return 3;
                }
                return 1;
            },
        });

        singlePageScroll.handleWheel(createWheelEvent(720, 10));
        expect(currentPage.value).toBe(3);
        expect(container.scrollTop).toBe(120);
    });
});
