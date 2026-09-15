import type {TDocumentViewMode} from '@contracts/shared';
import {
    createWheelFlipGate,
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/modules/document-viewer/public';

interface IPageSourcePagedWheelState {
    container: HTMLElement | null;
    continuousScroll: boolean;
    currentPage: number;
    pageCount: number;
    pageHeights: readonly number[];
    viewMode: TDocumentViewMode;
}

interface IPageSourceWheelEvent {
    deltaX: number;
    deltaY: number;
    preventDefault(): void;
}

export function createPageSourcePagedWheelNavigation(pageGutterPx: number) {
    const wheelFlipGate = createWheelFlipGate();
    let cursorPage: number | null = null;

    function reset() {
        cursorPage = null;
        wheelFlipGate.reset();
    }

    function handle(event: IPageSourceWheelEvent, state: IPageSourcePagedWheelState) {
        if (
            state.continuousScroll
            || Math.abs(event.deltaY) < Math.abs(event.deltaX)
            || event.deltaY === 0
            || !state.container
        ) {
            return null;
        }
        const desiredPage = cursorPage ?? state.currentPage;
        const pageHeight = state.pageHeights[desiredPage - 1];
        if (pageHeight === undefined) {
            return null;
        }
        const direction = resolveWheelDirection(event.deltaY);
        const bounds = {
            min: 0,
            max: Math.max(0, pageHeight + pageGutterPx * 2 - state.container.clientHeight),
        };
        if (canScrollWithinPageBounds(state.container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll();
            return null;
        }
        event.preventDefault();
        const now = performance.now();
        if (wheelFlipGate.shouldBlockFlip(direction, now, {delta: event.deltaY})) {
            return null;
        }
        const target = resolveWheelTargetPage(desiredPage, state.viewMode, state.pageCount, direction);
        if (target === desiredPage) {
            return null;
        }
        cursorPage = target;
        wheelFlipGate.recordFlip(direction, now, event.deltaY);
        return target;
    }

    return {
        handle,
        reset,
    };
}
