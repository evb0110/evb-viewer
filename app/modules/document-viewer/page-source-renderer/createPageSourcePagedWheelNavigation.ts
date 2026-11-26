import type {TDocumentViewMode} from '@contracts/shared';
import { createWheelFlipGate } from '@app/modules/document-viewer/single-page-wheel/createWheelFlipGate';
import {
    canScrollWithinPageBounds,
    resolveWheelDirection,
    resolveWheelTargetPage,
} from '@app/modules/document-viewer/single-page-wheel/singlePageWheelNavigation';

interface IPageSourcePagedWheelState {
    container: HTMLElement | null;
    continuousScroll: boolean;
    currentPage: number;
    pageCount: number;
    pageHeights: readonly number[];
    viewMode: TDocumentViewMode;
}

interface IPageSourceWheelEvent {
    cancelable?: boolean;
    deltaX: number;
    deltaY: number;
    timeStamp?: number;
    preventDefault(): void;
}

export function createPageSourcePagedWheelNavigation(pageGutterPx: number) {
    const wheelFlipGate = createWheelFlipGate();
    let cursorPage: number | null = null;

    function reset() {
        cursorPage = null;
        wheelFlipGate.reset();
    }

    function handle(event: IPageSourceWheelEvent, state: IPageSourcePagedWheelState, deltaPx = event.deltaY) {
        if (state.continuousScroll || !state.container) {
            return null;
        }
        const packet = {
            cancelable: event.cancelable ?? true,
            deltaY: deltaPx,
            timeStamp: event.timeStamp ?? performance.now(),
        };
        if (Math.abs(deltaPx) < Math.abs(event.deltaX) || deltaPx === 0) {
            if (wheelFlipGate.consumeGestureJitter(packet)) {
                event.preventDefault();
            }
            return null;
        }
        const desiredPage = cursorPage ?? state.currentPage;
        const pageHeight = state.pageHeights[desiredPage - 1];
        if (pageHeight === undefined) {
            return null;
        }
        const direction = resolveWheelDirection(deltaPx);
        const bounds = {
            min: 0,
            max: Math.max(0, pageHeight + pageGutterPx * 2 - state.container.clientHeight),
        };
        if (canScrollWithinPageBounds(state.container, bounds, direction)) {
            wheelFlipGate.recordInteriorScroll(packet);
            return null;
        }
        event.preventDefault();
        if (wheelFlipGate.shouldBlockFlip(direction, packet)) {
            return null;
        }
        const target = resolveWheelTargetPage(desiredPage, state.viewMode, state.pageCount, direction);
        if (target === desiredPage) {
            return null;
        }
        cursorPage = target;
        wheelFlipGate.recordFlip(direction, packet);
        return target;
    }

    return {
        handle,
        reset,
    };
}
