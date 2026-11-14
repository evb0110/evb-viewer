import type { TDocumentViewMode } from '@contracts/shared';
import { stepBySpread } from '@app/utils/pdfViewMode';
import type { TWheelDirection } from '@app/modules/document-viewer/single-page-wheel/singlePageWheelTypes';
const PAGE_SCROLL_EDGE_EPSILON = 1;

interface IPageScrollBounds {
    min: number;
    max: number;
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
