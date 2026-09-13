import type { TDocumentViewMode } from '@contracts/shared';
import { stepBySpread } from '@app/utils/pdfViewMode';
import type {
    TPageSnapAnchor,
    TWheelDirection,
} from '@app/modules/document-viewer/single-page-wheel/singlePageWheelTypes';
import type { IDocumentWheelInteraction } from '@app/modules/document-viewer/input/documentWheelInteraction';

const HORIZONTAL_INTENT_REJECT_RATIO = 1;
const PAGE_SCROLL_EDGE_EPSILON = 1;

interface IPageScrollBounds {
    min: number;
    max: number;
}

export function shouldHandleSinglePageWheel(
    interaction: IDocumentWheelInteraction,
    container: HTMLElement | null,
    hasPdfDocument: boolean,
    isContinuousScroll: boolean,
    isPdfLoading: boolean,
    pageCount: number,
) {
    const { event } = interaction;
    if (
        interaction.intent !== 'scroll' ||
        isContinuousScroll ||
        isPdfLoading ||
        !hasPdfDocument ||
        !container ||
        pageCount === 0
    ) {
        return false;
    }

    if (event.deltaY === 0) {
        return false;
    }

    return Math.abs(event.deltaX)
        <= Math.abs(event.deltaY) * HORIZONTAL_INTENT_REJECT_RATIO;
}

export function resolveWheelDirection(delta: number): TWheelDirection {
    return delta > 0 ? 1 : -1;
}

export function canScrollWithinPageBounds(
    container: HTMLElement,
    bounds: IPageScrollBounds,
    direction: TWheelDirection,
) {
    return direction > 0
        ? container.scrollTop < bounds.max - PAGE_SCROLL_EDGE_EPSILON
        : container.scrollTop > bounds.min + PAGE_SCROLL_EDGE_EPSILON;
}

export function hasScrollablePageBounds(bounds: IPageScrollBounds) {
    return bounds.max - bounds.min > PAGE_SCROLL_EDGE_EPSILON;
}

export function isWithinPageScrollBoundsInterior(
    container: HTMLElement,
    bounds: IPageScrollBounds,
) {
    if (!hasScrollablePageBounds(bounds)) {
        return false;
    }

    return (
        container.scrollTop > bounds.min + PAGE_SCROLL_EDGE_EPSILON
        && container.scrollTop < bounds.max - PAGE_SCROLL_EDGE_EPSILON
    );
}

export function resolveNextTopWithinPageBounds(
    container: HTMLElement,
    bounds: IPageScrollBounds,
    delta: number,
    direction: TWheelDirection,
) {
    return direction > 0
        ? Math.min(bounds.max, container.scrollTop + delta)
        : Math.max(bounds.min, container.scrollTop + delta);
}

export function resolveWheelTargetPage(
    activePage: number,
    viewMode: TDocumentViewMode,
    pageCount: number,
    direction: TWheelDirection,
) {
    // Keep paged scrolling predictable: one spread turn per wheel threshold.
    return stepBySpread(
        activePage,
        viewMode,
        pageCount,
        direction,
        1,
    );
}

export function resolveWheelTargetAnchor(
    targetPageIsTall: boolean,
    direction: TWheelDirection,
): TPageSnapAnchor {
    if (!targetPageIsTall) {
        return 'top';
    }
    return direction > 0 ? 'top' : 'bottom';
}
